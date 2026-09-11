declare module "mammoth/mammoth.browser" {
  export interface MammothHtmlResult {
    value: string;
    messages: unknown[];
  }
  export function convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<MammothHtmlResult>;
  const mammoth: { convertToHtml: typeof convertToHtml };
  export default mammoth;
}
