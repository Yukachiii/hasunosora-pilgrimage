declare module "exifr/dist/mini.esm.mjs" {
  export function gps(
    data: Blob | File | ArrayBuffer | Uint8Array,
  ): Promise<{ latitude: number; longitude: number } | undefined>;
}
