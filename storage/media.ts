export async function getMediaBucket(): Promise<R2Bucket> {
  const { env } = await import("cloudflare:workers");
  if (!env.MEDIA) {
    throw new Error(
      "Cloudflare R2 binding `MEDIA` is unavailable. Set the `r2` field in .openai/hosting.json to `MEDIA`.",
    );
  }

  return env.MEDIA;
}
