declare module "unzipper" {
  type ZipEntry = {
    path: string;
    type: "File" | "Directory" | string;
    externalFileAttributes?: number;
    flags?: number;
    vars?: {
      flags?: number;
      uncompressedSize?: number;
    };
    stream(): NodeJS.ReadableStream;
  };

  const unzipper: {
    Open: {
      file(path: string): Promise<{ files: ZipEntry[] }>;
    };
  };

  export default unzipper;
}
