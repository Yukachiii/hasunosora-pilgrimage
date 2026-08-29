export async function getMediaBucket(): Promise<R2Bucket> {
  const { env } = await import("cloudflare:workers");
  if (!env.MEDIA) {
    throw new Error(
      "Cloudflare R2 binding `MEDIA` is unavailable. Start the local application runtime with its configured bindings before using media storage.",
    );
  }

  return env.MEDIA;
}
