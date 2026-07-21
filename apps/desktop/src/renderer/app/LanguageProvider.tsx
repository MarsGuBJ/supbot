import { createContext, useCallback, useContext, type PropsWithChildren } from "react";
import { translate, type Language } from "../i18n";

export type Translator = (key: string, vars?: Record<string, string | number>) => string;

const LanguageContext = createContext<Translator | undefined>(undefined);

export function LanguageProvider({ language, children }: PropsWithChildren<{ language: Language }>) {
  const t = useCallback<Translator>((key, vars) => translate(language, key, vars), [language]);
  return <LanguageContext.Provider value={t}>{children}</LanguageContext.Provider>;
}

export function useT(): Translator {
  const t = useContext(LanguageContext);
  if (!t) throw new Error("useT must be used inside LanguageProvider.");
  return t;
}
