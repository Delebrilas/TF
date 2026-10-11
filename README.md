# TrackFetcher

Application de bureau (Windows, macOS, Linux) qui télécharge des morceaux depuis **Spotify, YouTube et SoundCloud** en **MP3**, détecte le **BPM**, le **vérifie en ligne** et l'écrit dans les tags ID3.

## Fonctionnement

1. **Lien** : piste, album ou playlist.
   - YouTube / SoundCloud : téléchargés via [yt-dlp](https://github.com/yt-dlp/yt-dlp).
   - Spotify ne fournit pas l'audio : l'app lit les métadonnées publiques de la page Spotify (sans compte ni clé), puis cherche l'enregistrement correspondant sur YouTube (durée, titre, chaîne « - Topic » officielle).
2. **MP3** : conversion par ffmpeg (320 kbps, V0 ou 192 kbps), pochette carrée intégrée.
3. **BPM local** : flux spectral → autocorrélation → affinage au centième (Rust, ~0,1 s par morceau).
4. **Vérification** : comparaison avec Deezer (sans clé), GetSongBPM (clé gratuite facultative) et un éventuel « 128 BPM » dans le titre ou la description. Les erreurs de double / moitié sont corrigées automatiquement.
   - ✓ **Confirmé** : analyse et sources d'accord.
   - ↕ **Corrigé** : analyse ajustée d'un facteur ×2, ×½, ×1,5.
   - ⚠ **À vérifier** : désaccord, la valeur se corrige d'un clic.
5. **Tags** : titre, artiste, album, pochette, `TBPM` (entier, lu par Rekordbox, Serato, iTunes, Windows) et le détail des sources dans `TXXX:BPM_DETAIL`.

Le bouton **Analyser des MP3** (ou un glisser-déposer) applique les étapes 3 à 5 à des fichiers existants.

Au premier lancement, l'app installe yt-dlp et ffmpeg dans son dossier de données (sous Linux, ffmpeg vient du gestionnaire de paquets). yt-dlp se met à jour tout seul.

## Stack

[Tauri 2](https://tauri.app) : cœur en Rust, interface HTML/CSS/JS sans framework. Exécutable d'environ 13 Mo, faible mémoire.

## Développement

```bash
npm install
npm run dev        # lance l'app
npm run build      # installateur pour l'OS courant
cargo test --release --manifest-path src-tauri/Cargo.toml
```

Test de bout en bout sur un vrai lien :

```bash
TF_E2E_URL="https://www.youtube.com/watch?v=..." cargo test --release --features e2e e2e --manifest-path src-tauri/Cargo.toml -- --nocapture
```

Les installateurs Windows / macOS / Linux sont produits par GitHub Actions (`.github/workflows/build.yml`) à chaque push sur `main` (installateurs dans l'onglet Actions) et chaque tag `v*` (release brouillon).

## Usage

Pour un usage personnel, sur des contenus que tu as le droit de télécharger.
