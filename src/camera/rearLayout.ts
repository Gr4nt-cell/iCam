/** Fill the rear display up to a narrow control rail; focus stays in camera-local coordinates. */
export function rearCameraFrame(width: number,height: number) {
  const rail=Math.min(96,Math.max(54,width*.10));
  const preview=Math.max(1,width-rail);
  return {left:0,top:0,width:preview,height};
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
