export type CameraFrame = { left: number; top: number; width: number; height: number };
export type PhotoAspect = '4:3' | '16:9' | '1:1' | 'full';

/** The camera gets its real capture shape, not the whole display with hidden letterboxing. */
export function cameraViewport(width: number, height: number, video: boolean, aspect: PhotoAspect, topInset = 0, bottomInset = 0): CameraFrame {
  const landscape = width > height;
  const ratio = video || aspect === '16:9' ? 9 / 16 : aspect === '1:1' ? 1 : 3 / 4;
  const target = landscape ? 1 / ratio : ratio;
  const availableWidth = Math.max(1, width - (landscape ? 184 : 0));
  const availableHeight = Math.max(1, height - topInset - bottomInset - (landscape ? 16 : 184));
  // Video fills the display width. On short displays the controls overlay the video,
  // instead of squeezing the image inward and introducing side bars.
  if(video){
    const w=availableWidth;const h=w/target;
    return {left:0,top:Math.max(0,Math.min(topInset+8,(height-h)/2)),width:w,height:h};
  }
  const w = Math.min(availableWidth, availableHeight * target);
  const h = w / target;
  return { left: (availableWidth - w) / 2, top: topInset + 8 + (availableHeight - h) / 2, width: w, height: h };
}

/** Migrate removed Horizon settings, including values saved by older APKs. */
export function restoreStabilization(value: unknown): 'off' | 'standard' | 'cinematic' {
  return value === 'off' || value === 'standard' ? value : 'cinematic';
}
