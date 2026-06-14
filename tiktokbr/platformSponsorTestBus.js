let platformSponsorTestHandler = null;

export function setPlatformSponsorTestHandler(handler) {
  platformSponsorTestHandler = typeof handler === 'function' ? handler : null;
}

export function triggerPlatformSponsorTest(payload) {
  if (!platformSponsorTestHandler) {
    const err = new Error('Platform sponsor test controls are not ready.');
    err.status = 503;
    throw err;
  }
  return platformSponsorTestHandler(payload || {});
}
