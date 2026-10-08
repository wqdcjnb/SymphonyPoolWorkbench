import { VIDEO_RATIOS } from '../public/js/video-policy.js';

export const THIRTY_SECOND_MODEL = 'Dreamina Seedance 2.5';

// Require a duration unit, with boundaries that exclude product IDs and 130s.
const thirtySeconds = /(?<![A-Za-z0-9_.０-９])(?:[3３][0０](?:[.．][0０]+)?[\s\u200b]*(?:[-‐‑–－][\s\u200b]*)?(?:seconds?|secs?\.?|[sＳｓ]|秒(?:钟|鐘)?)|三十\s*秒(?:钟|鐘)?|thirty[\s-]+seconds?)(?![A-Za-z0-9_０-９])/iu;

export const mentionsThirtySeconds = (...texts) => texts.some(text =>
  typeof text === 'string' && thirtySeconds.test(text));

// Read only the positive prompt. Negative prompts describe exclusions, not output settings.
// NFKC also accepts full-width digits/colons; boundaries exclude IDs and timecodes.
export function resolvePromptRatio(prompt, fallback) {
  const text = typeof prompt === 'string' ? prompt.normalize('NFKC') : '';
  const ratios = new Set();
  for (const match of text.matchAll(/(?<![A-Za-z0-9_.:∶])([1-9]\d?)\s*[:∶]\s*([1-9]\d?)(?![A-Za-z0-9_:∶])/gu)) {
    const clause = text.slice(0, match.index).split(/[，。；！？,;!?\n]/u).at(-1);
    if (/(?:不要|避免|禁止|不能|无需|不使用|不用|不采用|勿|非|\bnot\b|\bavoid\b|\bno\b|\bwithout\b)\s*(?:(?:使用|采用|生成|画面|视频|比例|画幅|宽高比|格式|竖屏|横屏|方形|the|an?|use|using|aspect\s+ratio|ratio|format)\s*)*[:：]?\s*$/iu.test(clause)) continue;
    ratios.add(`${match[1]}:${match[2]}`);
  }
  if (ratios.size > 1) throw new Error('PROMPT_RATIO_CONFLICT');
  const ratio = ratios.values().next().value;
  if (ratio && !VIDEO_RATIOS.includes(ratio)) throw new Error('PROMPT_RATIO_UNSUPPORTED');
  return ratio || fallback;
}
