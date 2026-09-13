import { copyFile, mkdir, stat } from "node:fs/promises";

const assetDirectory = new URL("../public/vad/", import.meta.url);
const assets = [
  ["../node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx", "silero_vad_v5.onnx"],
  ["../node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js", "vad.worklet.bundle.min.js"],
  ["../node_modules/@ricky0123/vad-web/dist/bundle.min.js", "bundle.min.js"],
  ["../node_modules/@ricky0123/vad-web/dist/bundle.min.js.LICENSE.txt", "bundle.min.js.LICENSE.txt"],
  ["../node_modules/onnxruntime-web/dist/ort.wasm.min.js", "ort.wasm.min.js"],
  ["../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.wasm"],
  ["../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.mjs"],
  ["../licenses/vad-LICENSES.txt", "LICENSES.txt"]
];

// 使用するV5モデルとWASM実行用ファイルだけを、同じオリジンで配信する。
// 依存パッケージからコピーし、この処理では外部通信を行わない。
const files = await Promise.all(assets.map(async ([source, name]) => {
  const path = new URL(source, import.meta.url);
  return { path, name, size: (await stat(path)).size };
}));
await mkdir(assetDirectory, { recursive: true });
await Promise.all(files.map(file => copyFile(file.path, new URL(file.name, assetDirectory))));
console.log(`VAD配信ファイルを /vad/ に準備しました: ${files.length} ファイル、${files.reduce((sum, file) => sum + file.size, 0).toLocaleString("en-US")} bytes`);
