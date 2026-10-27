/** Marked's UMD asset is embedded as text by Bun's static text import. */
declare module '*marked/lib/marked.umd.js' {
  const source: string;
  export default source;
}
