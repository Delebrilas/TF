//! Cast vers la télé (DLNA / UPnP, compris nativement par les Samsung Tizen,
//! LG, Sony, Philips…) : on trouve les télés du réseau, on leur sert le MP3
//! en HTTP et on les pilote (lecture, pause, position).

use anyhow::{anyhow, bail, Context, Result};
use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
pub struct Tv {
    pub name: String,
    pub model: String,
    /// URL de contrôle AVTransport.
    pub control: String,
}

fn client() -> reqwest::Client {
    // Réseau local : jamais de proxy.
    reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(6)).build().expect("client HTTP")
}

// ---------- Découverte (SSDP) ----------

const SSDP: &str = "239.255.255.250:1900";

fn ssdp_locations(wait: Duration) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(sock) = UdpSocket::bind("0.0.0.0:0") else { return out };
    let _ = sock.set_read_timeout(Some(Duration::from_millis(250)));
    for st in ["urn:schemas-upnp-org:device:MediaRenderer:1", "urn:schemas-upnp-org:service:AVTransport:1"] {
        let msg = format!("M-SEARCH * HTTP/1.1\r\nHOST: {SSDP}\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: {st}\r\n\r\n");
        for _ in 0..2 {
            let _ = sock.send_to(msg.as_bytes(), SSDP);
        }
    }
    let end = Instant::now() + wait;
    let mut buf = [0u8; 2048];
    while Instant::now() < end {
        if let Ok((n, _)) = sock.recv_from(&mut buf) {
            let text = String::from_utf8_lossy(&buf[..n]);
            for line in text.lines() {
                if let Some((k, v)) = line.split_once(':') {
                    if k.trim().eq_ignore_ascii_case("location") {
                        let v = v.trim().to_string();
                        if !out.contains(&v) {
                            out.push(v);
                        }
                    }
                }
            }
        }
    }
    out
}

fn tag(xml: &str, name: &str) -> Option<String> {
    let re = Regex::new(&format!(r"(?s)<(?:\w+:)?{name}>\s*(.*?)\s*</(?:\w+:)?{name}>")).ok()?;
    re.captures(xml).map(|c| unescape(&c[1]))
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Description d'appareil → télé pilotable (service AVTransport présent).
fn parse_device(xml: &str, location: &str) -> Option<Tv> {
    static SERVICE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<service>(.*?)</service>").unwrap());
    let control = SERVICE
        .captures_iter(xml)
        .map(|c| c[1].to_string())
        .find(|s| tag(s, "serviceType").is_some_and(|t| t.contains(":AVTransport:")))
        .and_then(|s| tag(&s, "controlURL"))?;
    let base = tag(xml, "URLBase").unwrap_or_else(|| location.to_string());
    let base = reqwest::Url::parse(&base).ok()?;
    Some(Tv {
        name: tag(xml, "friendlyName").unwrap_or_else(|| "Télé".into()),
        model: tag(xml, "modelName").unwrap_or_default(),
        control: base.join(&control).ok()?.to_string(),
    })
}

pub async fn discover() -> Vec<Tv> {
    let locs = tokio::task::spawn_blocking(|| ssdp_locations(Duration::from_millis(3000))).await.unwrap_or_default();
    let c = client();
    let mut tvs: Vec<Tv> = Vec::new();
    for loc in locs {
        let Ok(r) = c.get(&loc).send().await else { continue };
        let Ok(xml) = r.text().await else { continue };
        if let Some(tv) = parse_device(&xml, &loc) {
            if !tvs.iter().any(|t| t.control == tv.control) {
                tvs.push(tv);
            }
        }
    }
    tvs
}

// ---------- Serveur HTTP local (le MP3 et sa pochette pour la télé) ----------

struct Server {
    port: u16,
    files: HashMap<String, PathBuf>,
    covers: HashMap<String, Vec<u8>>,
}
static SERVER: Mutex<Option<Server>> = Mutex::new(None);

async fn ensure_server() -> Result<u16> {
    if let Some(s) = SERVER.lock().unwrap().as_ref() {
        return Ok(s.port);
    }
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", 0)).await.context("serveur local")?;
    let port = listener.local_addr()?.port();
    *SERVER.lock().unwrap() = Some(Server { port, files: HashMap::new(), covers: HashMap::new() });
    tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = listener.accept().await else { continue };
            tokio::spawn(async move {
                let _ = serve(sock).await;
            });
        }
    });
    Ok(port)
}

const DLNA_MP3: &str = "DLNA.ORG_PN=MP3;DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000";

async fn serve(mut sock: tokio::net::TcpStream) -> Result<()> {
    let mut buf = vec![0u8; 8192];
    let mut n = 0;
    loop {
        let r = sock.read(&mut buf[n..]).await?;
        if r == 0 {
            return Ok(());
        }
        n += r;
        if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") || n == buf.len() {
            break;
        }
    }
    let req = String::from_utf8_lossy(&buf[..n]).to_string();
    let mut lines = req.lines();
    let first = lines.next().unwrap_or("");
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");
    let range = lines
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("range"))
        .map(|(_, v)| v.trim().to_string());
    let head = method == "HEAD";
    let id = path.trim_start_matches('/').split(['.', '?']).next().unwrap_or("").to_string();

    if let Some(rest) = id.strip_prefix("c-") {
        let data = SERVER.lock().unwrap().as_ref().and_then(|s| s.covers.get(rest).cloned());
        let Some(data) = data else { return not_found(&mut sock).await };
        let ct = if data.starts_with(&[0x89, b'P']) { "image/png" } else { "image/jpeg" };
        let h = format!("HTTP/1.1 200 OK\r\nContent-Type: {ct}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", data.len());
        sock.write_all(h.as_bytes()).await?;
        if !head {
            sock.write_all(&data).await?;
        }
        return Ok(());
    }

    let file = SERVER.lock().unwrap().as_ref().and_then(|s| s.files.get(&id).cloned());
    let Some(file) = file else { return not_found(&mut sock).await };
    let mut f = tokio::fs::File::open(&file).await?;
    let size = f.metadata().await?.len();
    let (start, end) = range
        .as_deref()
        .and_then(parse_range)
        .map(|(a, b)| (a.min(size.saturating_sub(1)), b.unwrap_or(size - 1).min(size - 1)))
        .unwrap_or((0, size.saturating_sub(1)));
    let len = end + 1 - start;
    let status = if range.is_some() { "206 Partial Content" } else { "200 OK" };
    let mut h = format!(
        "HTTP/1.1 {status}\r\nContent-Type: audio/mpeg\r\nContent-Length: {len}\r\nAccept-Ranges: bytes\r\n\
         transferMode.dlna.org: Streaming\r\ncontentFeatures.dlna.org: {DLNA_MP3}\r\nConnection: close\r\n"
    );
    if range.is_some() {
        h.push_str(&format!("Content-Range: bytes {start}-{end}/{size}\r\n"));
    }
    h.push_str("\r\n");
    sock.write_all(h.as_bytes()).await?;
    if head {
        return Ok(());
    }
    f.seek(std::io::SeekFrom::Start(start)).await?;
    let mut left = len;
    let mut chunk = vec![0u8; 64 * 1024];
    while left > 0 {
        let want = chunk.len().min(left as usize);
        let r = f.read(&mut chunk[..want]).await?;
        if r == 0 {
            break;
        }
        sock.write_all(&chunk[..r]).await?;
        left -= r as u64;
    }
    Ok(())
}

fn parse_range(v: &str) -> Option<(u64, Option<u64>)> {
    let r = v.strip_prefix("bytes=")?;
    let (a, b) = r.split_once('-')?;
    Some((a.trim().parse().ok()?, b.trim().parse().ok()))
}

async fn not_found(sock: &mut tokio::net::TcpStream) -> Result<()> {
    sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await?;
    Ok(())
}

/// Adresse du PC vue depuis la télé.
fn local_ip_towards(control: &str) -> Result<IpAddr> {
    let url = reqwest::Url::parse(control)?;
    let host = url.host_str().ok_or_else(|| anyhow!("adresse de télé invalide"))?;
    let port = url.port_or_known_default().unwrap_or(80);
    let target: SocketAddr = format!("{host}:{port}").parse()?;
    let s = UdpSocket::bind("0.0.0.0:0")?;
    s.connect(target)?;
    Ok(s.local_addr()?.ip())
}

// ---------- Pilotage (SOAP AVTransport) ----------

async fn soap(control: &str, action: &str, args: &str) -> Result<String> {
    let body = format!(
        r#"<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:{action} xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID>{args}</u:{action}></s:Body></s:Envelope>"#
    );
    let r = client()
        .post(control)
        .header("Content-Type", "text/xml; charset=\"utf-8\"")
        .header("SOAPACTION", format!("\"urn:schemas-upnp-org:service:AVTransport:1#{action}\""))
        .body(body)
        .send()
        .await
        .map_err(|_| anyhow!("La télé ne répond pas (allumée et sur le même Wi-Fi ?)"))?;
    let ok = r.status().is_success();
    let text = r.text().await.unwrap_or_default();
    if !ok {
        let why = tag(&text, "errorDescription").unwrap_or_else(|| tag(&text, "faultstring").unwrap_or_default());
        bail!("La télé refuse « {action} » {why}");
    }
    Ok(text)
}

fn hms(t: f64) -> String {
    let s = t.max(0.0) as u64;
    format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
}

fn secs(hms: &str) -> Option<f64> {
    let mut v = 0.0;
    for p in hms.split(':') {
        v = v * 60.0 + p.parse::<f64>().ok()?;
    }
    Some(v)
}

pub struct Media {
    pub path: String,
    pub title: String,
    pub artist: String,
    pub duration: Option<f64>,
    pub cover: Option<Vec<u8>>,
}

/// Envoie un morceau à la télé et lance la lecture (à `start` secondes).
pub async fn play(control: &str, m: Media, start: Option<f64>) -> Result<()> {
    let port = ensure_server().await?;
    let ip = local_ip_towards(control)?;
    let id = format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos());
    let has_cover = m.cover.is_some();
    {
        let mut g = SERVER.lock().unwrap();
        let s = g.as_mut().unwrap();
        // Quelques morceaux récents seulement (la télé peut relire le précédent).
        if s.files.len() > 8 {
            s.files.clear();
            s.covers.clear();
        }
        s.files.insert(id.clone(), PathBuf::from(&m.path));
        if let Some(c) = m.cover {
            s.covers.insert(id.clone(), c);
        }
    }
    let url = format!("http://{ip}:{port}/{id}.mp3");
    let art = if has_cover { format!("<upnp:albumArtURI>http://{ip}:{port}/c-{id}.jpg</upnp:albumArtURI>") } else { String::new() };
    let dur = m.duration.map(|d| format!(r#" duration="{}.000""#, hms(d))).unwrap_or_default();
    let didl = format!(
        r#"<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="{id}" parentID="0" restricted="1"><dc:title>{}</dc:title><dc:creator>{}</dc:creator><upnp:artist>{}</upnp:artist>{art}<upnp:class>object.item.audioItem.musicTrack</upnp:class><res protocolInfo="http-get:*:audio/mpeg:{DLNA_MP3}"{dur}>{}</res></item></DIDL-Lite>"#,
        escape(&m.title),
        escape(&m.artist),
        escape(&m.artist),
        escape(&url)
    );
    let _ = soap(control, "Stop", "").await;
    soap(control, "SetAVTransportURI", &format!("<CurrentURI>{}</CurrentURI><CurrentURIMetaData>{}</CurrentURIMetaData>", escape(&url), escape(&didl))).await?;
    soap(control, "Play", "<Speed>1</Speed>").await?;
    if let Some(t) = start.filter(|t| *t > 1.0) {
        // La télé doit d'abord avoir chargé le flux.
        for _ in 0..10 {
            tokio::time::sleep(Duration::from_millis(400)).await;
            if seek(control, t).await.is_ok() {
                break;
            }
        }
    }
    Ok(())
}

pub async fn pause(control: &str) -> Result<()> {
    soap(control, "Pause", "").await.map(|_| ())
}
pub async fn resume(control: &str) -> Result<()> {
    soap(control, "Play", "<Speed>1</Speed>").await.map(|_| ())
}
pub async fn stop(control: &str) -> Result<()> {
    soap(control, "Stop", "").await.map(|_| ())
}
pub async fn seek(control: &str, t: f64) -> Result<()> {
    soap(control, "Seek", &format!("<Unit>REL_TIME</Unit><Target>{}</Target>", hms(t))).await.map(|_| ())
}

#[derive(Serialize)]
pub struct Status {
    /// PLAYING, PAUSED_PLAYBACK, STOPPED, TRANSITIONING…
    pub state: String,
    pub position: Option<f64>,
    pub duration: Option<f64>,
}

pub async fn status(control: &str) -> Result<Status> {
    let t = soap(control, "GetTransportInfo", "").await?;
    let p = soap(control, "GetPositionInfo", "").await.unwrap_or_default();
    Ok(Status {
        state: tag(&t, "CurrentTransportState").unwrap_or_default(),
        position: tag(&p, "RelTime").and_then(|s| secs(&s)),
        duration: tag(&p, "TrackDuration").and_then(|s| secs(&s)).filter(|d| *d > 0.0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_samsung_description() {
        let xml = r#"<root><URLBase>http://192.168.1.20:9197/</URLBase><device><friendlyName>[TV] Samsung Q60 Salon</friendlyName><modelName>QE55Q60</modelName>
          <serviceList><service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/upnp/control/RenderingControl1</controlURL></service>
          <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/upnp/control/AVTransport1</controlURL></service></serviceList></device></root>"#;
        let tv = parse_device(xml, "http://192.168.1.20:9197/dmr").unwrap();
        assert_eq!(tv.name, "[TV] Samsung Q60 Salon");
        assert_eq!(tv.control, "http://192.168.1.20:9197/upnp/control/AVTransport1");
        // Sans URLBase : relatif à l'adresse de la description.
        let tv = parse_device(&xml.replace("<URLBase>http://192.168.1.20:9197/</URLBase>", ""), "http://10.0.0.5:7676/smp_2_").unwrap();
        assert_eq!(tv.control, "http://10.0.0.5:7676/upnp/control/AVTransport1");
        assert!(parse_device("<root><service><serviceType>x:ContentDirectory:1</serviceType></service></root>", "http://a/").is_none());
    }

    #[test]
    fn times_and_ranges() {
        assert_eq!(hms(3725.4), "1:02:05");
        assert_eq!(secs("0:03:20.500"), Some(200.5));
        assert_eq!(parse_range("bytes=100-"), Some((100, None)));
        assert_eq!(parse_range("bytes=0-1023"), Some((0, Some(1023))));
    }

    /// Contre un faux récepteur DLNA local (TF_CAST_CONTROL=http://127.0.0.1:48555/ctl).
    #[tokio::test]
    #[ignore]
    async fn drives_a_renderer() {
        let control = std::env::var("TF_CAST_CONTROL").unwrap();
        let f = std::env::temp_dir().join("tf-cast-b.mp3");
        std::fs::write(&f, vec![1u8; 5000]).unwrap();
        let m = Media { path: f.display().to_string(), title: "Titre & Co".into(), artist: "Artiste".into(), duration: Some(200.0), cover: Some(vec![0xff, 0xd8, 1, 2]) };
        play(&control, m, Some(30.0)).await.unwrap();
        pause(&control).await.unwrap();
        let s = status(&control).await.unwrap();
        println!("état {} {:?} {:?}", s.state, s.position, s.duration);
    }

    #[tokio::test]
    async fn serves_ranges() {
        let dir = std::env::temp_dir().join("tf-cast-test");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.mp3");
        std::fs::write(&f, (0..=255u8).collect::<Vec<_>>()).unwrap();
        let port = ensure_server().await.unwrap();
        SERVER.lock().unwrap().as_mut().unwrap().files.insert("abc".into(), f);
        let c = client();
        let r = c.get(format!("http://127.0.0.1:{port}/abc.mp3")).header("Range", "bytes=10-19").send().await.unwrap();
        assert_eq!(r.status().as_u16(), 206);
        assert!(r.headers()["contentfeatures.dlna.org"].to_str().unwrap().contains("MP3"));
        assert_eq!(r.bytes().await.unwrap().to_vec(), (10..20u8).collect::<Vec<_>>());
        let r = c.get(format!("http://127.0.0.1:{port}/abc.mp3")).send().await.unwrap();
        assert_eq!(r.bytes().await.unwrap().len(), 256);
        assert_eq!(c.get(format!("http://127.0.0.1:{port}/zzz.mp3")).send().await.unwrap().status().as_u16(), 404);
    }
}
