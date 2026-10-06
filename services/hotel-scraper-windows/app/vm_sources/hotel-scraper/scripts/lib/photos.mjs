// Resolve one hotel's Google photos into displayable image URLs.
//
// Flow per hotel (must already have a place_id):
//   1. getPlacePhotos(placeId)  — fetch FRESH photo names (Place Details, field
//                                 mask "photos"). Billed IDs-Only = FREE. We never
//                                 trust stored names (ToS §3.2.3(b): not cacheable).
//   2. take the top N names (config.photos.maxPerHotel).
//   3. resolvePhotoUri(name)    — turn each into an actual image URL (Place Photo
//                                 media, skipHttpRedirect). This is the PAID part
//                                 (~$7 / 1000 successful fetches).
//
// Returns a plain result; persistence (savePhotos / markPhotosNone / markPhotosError)
// is the worker's job so this stays pure and unit-testable with a mocked client.

import { getPlacePhotos, resolvePhotoUri } from "./places-client.mjs";
import { config } from "./config.mjs";

function firstAttribution(p) {
  const a = Array.isArray(p?.authorAttributions) ? p.authorAttributions[0] : null;
  if (!a) return null;
  return { displayName: a.displayName || null, uri: a.uri || null };
}

// hotel: { id, placeId, name, photoRefs }
// Returns { status:'done'|'none', photos:[{ref,uri,widthPx,heightPx,attribution}],
//           refs:[...allNames], billedMedia } where billedMedia is the number of
// media calls that returned HTTP 200 (i.e. were billed) — the worker uses it to
// record spend accurately, including 200-but-empty responses.
export async function resolveHotelPhotos(
  hotel,
  { maxPerHotel = config.photos.maxPerHotel, maxWidthPx = config.photos.maxWidthPx } = {},
) {
  const placeId = hotel?.placeId;
  if (!placeId) return { status: "none", photos: [], refs: [], billedMedia: 0 };

  // Fresh names — free. A stale/removed place_id makes getPlacePhotos throw (404),
  // which the worker turns into a retryable 'error'.
  const found = await getPlacePhotos(placeId);
  const refs = found.map((p) => p?.name).filter(Boolean);
  if (!refs.length) return { status: "none", photos: [], refs: [], billedMedia: 0 };

  const top = found.filter((p) => p?.name).slice(0, Math.max(0, maxPerHotel));
  const photos = [];
  let billedMedia = 0;
  for (const p of top) {
    let uri = null;
    try {
      uri = await resolvePhotoUri(p.name, { maxWidthPx });
      billedMedia++; // a non-throwing return means the media call got a billed 200
    } catch (err) {
      // One bad photo shouldn't fail the whole hotel — skip it and keep going.
      // A throw means non-2xx (not billed), so billedMedia is untouched.
      console.log(
        JSON.stringify({ event: "photos.media_fail", placeId, ref: p.name, message: err.message }),
      );
      continue;
    }
    if (!uri) continue;
    photos.push({
      ref: p.name,
      uri,
      widthPx: Number.isInteger(p.widthPx) ? p.widthPx : null,
      heightPx: Number.isInteger(p.heightPx) ? p.heightPx : null,
      attribution: firstAttribution(p),
    });
  }

  // Place has photos but every media fetch failed -> treat as error (retry later)
  // rather than 'none', which would wrongly mark it settled. Carry billedMedia on
  // the error so the worker still records any 200-but-empty responses as spend.
  if (!photos.length) {
    const e = new Error("all media fetches failed");
    e.softAllFailed = true;
    e.billedMedia = billedMedia;
    throw e;
  }
  return { status: "done", photos, refs, billedMedia };
}
