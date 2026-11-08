/** Portrait viewfinder beside Xiaomi-style controls, with focus in camera-local coordinates. */
export function rearCameraFrame(width: number,height: number) {
  const rail=Math.min(110,Math.max(58,width*.115));
  const preview=Math.max(1,Math.min(width-rail,height*.75));
  return {left:Math.max(0,width-rail-preview),top:0,width:preview,height};
}
export function cameraFocusPoint(x:number,y:number,width:number,height:number,rear:boolean) {
  if(!rear)return {x,y};
  const frame=rearCameraFrame(width,height);
  if(x<frame.left||x>frame.left+frame.width||y<0||y>height)return null;
  return {x:x-frame.left,y};
}
export function mirrorPhoto(facing:string,frontMirror:boolean,rear:boolean,already?:number) {
  if(rear)return already!==1;
  return facing==='front'&&(already===1?!frontMirror:frontMirror);
}
