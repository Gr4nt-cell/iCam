/**
 * Share of a landscape rear display that sits under the two stacked camera lenses (left side on
 * the Xiaomi 17 Pro Max). Nothing is drawn there; the live image starts just right of the lenses.
 */
export const REAR_LENS_ZONE=0.25;
/** Live image between the lens zone and the control rail; focus stays in camera-local coordinates. */
export function rearCameraFrame(width: number,height: number) {
  const lens=width>height?Math.round(width*REAR_LENS_ZONE):0;
  const rail=Math.min(110,Math.max(58,width*.15));
  const preview=Math.max(1,width-lens-rail);
  return {left:lens,top:0,width:preview,height};
}
export function cameraFocusPoint(x:number,y:number,width:number,height:number,rear:boolean) {
  if(!rear)return {x,y};
  const frame=rearCameraFrame(width,height);
  if(x<frame.left||x>=frame.left+frame.width||y<0||y>=height)return null;
  return {x:x-frame.left,y};
}
export function mirrorPhoto(facing:string,frontMirror:boolean,rear:boolean,already?:number) {
  if(rear)return already!==1;
  return facing==='front'&&(already===1?!frontMirror:frontMirror);
}
