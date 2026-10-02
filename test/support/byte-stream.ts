export async function* bytesStream(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}
