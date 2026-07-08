/**
 * Ambient declarations for the Vendetta/Revenge runtime modules.
 *
 * These are provided by the client loader at runtime (marked external in the
 * build), so there's no npm package — we just declare their shapes as `any`
 * so TypeScript is happy and the imports compile to require("@vendetta/...")
 * calls the loader resolves.
 */

declare module "@vendetta/metro" {
  export const findByProps: (...names: string[]) => any;
  export const findByStoreName: (name: string) => any;
  export const findByName: (name: string) => any;
}

declare module "@vendetta/metro/common" {
  export const React: any;
  export const ReactNative: any;
  export const FluxDispatcher: any;
  export const constants: any;
}

declare module "@vendetta/patcher" {
  export const before: (
    name: string,
    object: any,
    callback: (args: any[]) => any
  ) => () => void;
  export const after: (
    name: string,
    object: any,
    callback: (args: any[], ret: any) => any
  ) => () => void;
  export const instead: (
    name: string,
    object: any,
    callback: (args: any[], orig: (...a: any[]) => any) => any
  ) => () => void;
}

declare module "@vendetta/plugin" {
  export const storage: Record<string, any>;
  export const manifest: any;
  export const id: string;
}

declare module "@vendetta/ui/toasts" {
  export const showToast: (content: string, asset?: number) => void;
}
