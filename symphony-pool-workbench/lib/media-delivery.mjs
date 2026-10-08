import { createReadStream, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

export const WATERMARK_ERROR = "WATERMARK_FREE_RESULT_REQUIRED";
export const deliveryReceiptPath = (target) => `${target}.delivery.json`;
const tracked = receipt => receipt.version === 3
  && receipt.processing?.method === 'opencv_temporal_inpaint'
  && receipt.processing?.preset === 'dola-tracked-glyph-v1'
  && /^[a-f0-9]{64}$/.test(receipt.processing?.template_sha256 || '');

export function assertDelivery(target, details, mode = 'official_original') {
  if (mode === 'official_original') return assertWatermarkFree(target, details);
  try {
    const receipt = JSON.parse(readFileSync(deliveryReceiptPath(target), 'utf8'));
    const legacy = receipt.version === 2 && receipt.processing?.method === 'ffmpeg_delogo'
      && ['dola-960-square-bottom-right-v1','dola-720-portrait-bottom-right-v1','dola-1280-landscape-bottom-right-v1'].includes(receipt.processing?.preset);
    if (mode !== 'watermark_repair' || (!legacy && !tracked(receipt)) || receipt.source !== 'dola_postprocessed'
      || receipt.delivery_mode !== mode || receipt.watermark_free !== null || receipt.postprocessed !== true
      || !/^[a-f0-9]{64}$/.test(receipt.source_sha256 || '')
      || receipt.sha256 !== details.sha256 || receipt.size_bytes !== details.sizeBytes) throw new Error();
    return receipt;
  } catch { throw new Error('WATERMARK_REPAIR_FAILED'); }
}

// Default workbench playback must never fall back to an unprocessed Dola clip.
export async function assertTrackedDolaVideo(target) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  const details = { sizeBytes: statSync(target).size, sha256: hash.digest('hex') };
  const receipt = assertDelivery(target, details, 'watermark_repair');
  if (!tracked(receipt)) throw new Error('WATERMARK_REPAIR_FAILED');
  return receipt;
}

export function assertWatermarkFree(target, { sha256, sizeBytes }) {
  try {
    const receipt = JSON.parse(readFileSync(deliveryReceiptPath(target), "utf8"));
    if (receipt.version !== 1 || receipt.source !== "doubao_authorized_original"
      || receipt.watermark_free !== true || !/^[a-f0-9]{64}$/.test(receipt.sha256 || "")
      || !/^[a-f0-9]{32}$/.test(receipt.source_md5 || "")
      || receipt.sha256 !== sha256 || receipt.size_bytes !== sizeBytes) throw new Error();
    return receipt;
  } catch { throw new Error(WATERMARK_ERROR); }
}
