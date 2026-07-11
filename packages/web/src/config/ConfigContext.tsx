import { createContext, useContext, type ReactNode } from "react";
import type { AppConfig } from "../config.ts";

const ConfigContext = createContext<AppConfig | undefined>(undefined);

export function ConfigProvider(props: {
  readonly config: AppConfig;
  readonly children: ReactNode;
}) {
  return (
    <ConfigContext.Provider value={props.config}>
      {props.children}
    </ConfigContext.Provider>
  );
}

export function useAppConfig(): AppConfig {
  const config = useContext(ConfigContext);
  if (config === undefined) {
    throw new Error("useAppConfig must be used within ConfigProvider");
  }
  return config;
}
