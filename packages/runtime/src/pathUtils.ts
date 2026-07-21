import { isAbsolute, relative, resolve } from "node:path";

export function pathIsInside(parent: string, child: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
