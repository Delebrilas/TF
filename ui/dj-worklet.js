// Keylock : décale la hauteur pour compenser le changement de vitesse
// (deux têtes de lecture sur une ligne à retard, fondu en sin²).
// Latence moyenne : W / 2, identique à la voie sans keylock.

const WINDOW = 0.04; // secondes

class Keylock extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "pitch", defaultValue: 1, minValue: 0.5, maxValue: 2, automationRate: "a-rate" }];
  }

  constructor() {
    super();
    this.W = Math.round(sampleRate * WINDOW);
    this.N = 1 << 15;
    this.buf = [new Float32Array(this.N), new Float32Array(this.N)];
    this.w = 0;
    this.d = 0;
  }

  read(ch, delay) {
    const N = this.N;
    const pos = this.w - 1 - delay;
    const i = Math.floor(pos);
    const f = pos - i;
    const b = this.buf[ch];
    return b[(i + N) & (N - 1)] * (1 - f) + b[(i + 1 + N) & (N - 1)] * f;
  }

  process(inputs, outputs, params) {
    const inp = inputs[0];
    const out = outputs[0];
    const p = params.pitch;
    const W = this.W;
    const n = out[0].length;
    for (let i = 0; i < n; i++) {
      const pitch = p.length > 1 ? p[i] : p[0];
      const l = inp[0] ? inp[0][i] : 0;
      const r = inp[1] ? inp[1][i] : l;
      this.buf[0][this.w] = l;
      this.buf[1][this.w] = r;
      this.w = (this.w + 1) & (this.N - 1);
      const step = 1 - pitch;
      if (Math.abs(step) < 5e-4) {
        // Vitesse normale : on revient doucement sur une seule tête (pas de filtre en peigne).
        const target = this.d < W / 2 ? 0 : W;
        this.d += Math.sign(target - this.d) * Math.min(5e-4, Math.abs(target - this.d));
      } else {
        this.d += step;
      }
      if (this.d >= W) this.d -= W;
      if (this.d < 0) this.d += W;
      const d1 = this.d;
      const d2 = (this.d + W / 2) % W;
      const s1 = Math.sin((Math.PI * d1) / W);
      const g1 = s1 * s1;
      const g2 = 1 - g1;
      for (let c = 0; c < out.length; c++) {
        const ch = c & 1;
        out[c][i] = g1 * this.read(ch, d1) + g2 * this.read(ch, d2);
      }
    }
    return true;
  }
}

registerProcessor("keylock", Keylock);
