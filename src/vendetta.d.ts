/**
 * Ambient declarations for the Vendetta/Revenge runtime modules.
 * Provided by the loader at runtime (mapped to the `vendetta.*` global by the
 * build), so there's no npm package — declare shapes as `any`.
 */
declare const module: { exports: any };

declare module "@vendetta/metro" {
  export const findByProps: (...names: string[]) => any;
  export const findByName: (name: string, defaultExport?: boolean) => any;
  export const findByStoreName: (name: string) => any;
}
declare module "@vendetta/metro/common" {
  export const React: any;
  export const ReactNative: any;
  export const FluxDispatcher: any;
}
declare module "@vendetta/patcher" {
  export const before: (name: string, obj: any, cb: (args: any[]) => any) => () => void;
  export const after: (name: string, obj: any, cb: (args: any[], ret: any) => any) => () => void;
  export const instead: (
    name: string,
    obj: any,
    cb: (args: any[], orig: (...a: any[]) => any) => any
  ) => () => void;
}
declare module "@vendetta/plugin" {
  export const storage: Record<string, any>;
}
declare module "@vendetta/storage" {
  export const useProxy: (storage: any) => any;
}
declare module "@vendetta/ui/components" {
  export const Forms: any;
}
declare module "@vendetta/ui/assets" {
  export const getAssetIDByName: (name: string) => any;
}
