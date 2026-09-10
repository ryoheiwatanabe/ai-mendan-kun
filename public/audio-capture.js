/* マイク音声はメモリ内の短いブロックだけをメインスレッドへ渡す。出力は無音。 */
class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(2048);
    this.offset = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let index = 0; index < channels[0].length; index++) {
      let value = 0;
      for (const channel of channels) value += channel[index] || 0;
      this.samples[this.offset++] = value / channels.length;
      if (this.offset === this.samples.length) {
        this.port.postMessage(this.samples, [this.samples.buffer]);
        this.samples = new Float32Array(2048);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("voice-capture", VoiceCapture);
