/** jschardet 无官方类型包（@types/jschardet 不存在），本地声明最小 API 面。 */
declare module "jschardet" {
  export interface JsChardetResult {
    encoding: string | null;
    confidence: number;
  }
  export function detect(buffer: Buffer | Uint8Array | string): JsChardetResult;
  const jschardet: { detect: typeof detect };
  export default jschardet;
}
