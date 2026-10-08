export const DAILY_CREDITS = 10;
export const VIDEO_FIXED_RATIOS = ["9:16", "16:9", "1:1", "3:4", "4:3", "21:9"];
export const VIDEO_RATIOS = VIDEO_FIXED_RATIOS;
export const VIDEO_CATALOG = [
  { service: "doubao", model: "Seedance 2.0 Fast", version: "2.0 Fast", duration: 15, credits: 2, maxImages: 9, ratios: VIDEO_RATIOS },
  { service: "doubao", model: "Seedance 2.0 Mini", version: "2.0 Mini", duration: 15, credits: 2, maxImages: 9, ratios: VIDEO_RATIOS },
  { service: "dola", model: "Dreamina Seedance 2.5", version: "2.5", duration: 30, credits: 4, maxImages: 9, ratios: VIDEO_FIXED_RATIOS },
];
export const videoModel = (model) => VIDEO_CATALOG.find((item) => item.model === model);
export const videoCreditCost = (model, duration) => {
  const item = videoModel(model);
  return item?.duration === duration ? item.credits : 0;
};
