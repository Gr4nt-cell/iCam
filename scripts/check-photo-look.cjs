// Compile and render the real smoothing shader in software Skia. No camera / GPU required.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const entry=require.resolve('canvaskit-wasm/bin/full/canvaskit.js');
(async()=>{
 const ck=await require(entry)({locateFile:f=>path.join(path.dirname(entry),f)});
 const source=fs.readFileSync(path.join(__dirname,'../src/processing/shaders.ts'),'utf8');
 const text=source.match(/export const SMOOTH_SKSL = `([\s\S]*?)`;/)[1];
 let error='';const fx=ck.RuntimeEffect.Make(text,e=>error=e);assert(fx,error);assert.equal(fx.getUniformFloatCount(),25);
 const W=128,H=128,pixels=new Uint8Array(W*H*4);
 for(let y=0;y<H;y++)for(let x=0;x<W;x++){
  const i=(y*W+x)*4,n=((x*17+y*31)%9)-4;
  // Synthetic skin texture, with a sharp dark facial feature crossing the face box.
  const base=(x>58&&x<66&&y>44&&y<58)?[30,20,18]:[145+n,100+n,78+n];pixels.set([...base,255],i);
 }
 const info={width:W,height:H,colorType:ck.ColorType.RGBA_8888,alphaType:ck.AlphaType.Unpremul,colorSpace:ck.ColorSpace.SRGB};
 const img=ck.MakeImage(info,pixels,W*4);assert(img);
 const child=img.makeShaderCubic(ck.TileMode.Clamp,ck.TileMode.Clamp,0,0);
 const uniforms=[.8,3,W,H,1,.25,.2,.5,.6,...Array(16).fill(0)];
 const shader=fx.makeShaderWithChildren(uniforms,[child]);const surface=ck.MakeSurface(W,H);assert(surface);
 const paint=new ck.Paint();paint.setShader(shader);surface.getCanvas().drawPaint(paint);
 const snapshot=surface.makeImageSnapshot(),result=snapshot.readPixels(0,0,info);assert(result);
 let outside=0,insideDelta=0,insideCount=0;const before=[],after=[];
 for(let y=0;y<H;y++)for(let x=0;x<W;x++){
  const i=(y*W+x)*4;
  if(x<20||x>108)for(let c=0;c<3;c++)outside=Math.max(outside,Math.abs(result[i+c]-pixels[i+c]));
  if(x>42&&x<85&&y>65&&y<85){insideDelta+=result[i]-pixels[i];insideCount++;before.push(pixels[i]);after.push(result[i]);}
 }
 assert(outside<=1,'Background outside the detected face must stay unchanged');
 function variance(a){const mean=a.reduce((s,x)=>s+x,0)/a.length;return a.reduce((s,x)=>s+(x-mean)**2,0)/a.length}
 assert(variance(after)<variance(before)*.95,'Skin texture noise should actually decrease');
 assert(Math.abs(insideDelta/insideCount)<2,'Smoothing must not brighten / whiten the complexion');
 const eye=(50*W+62)*4;assert(result[eye]<45,'Dark facial features must retain their contrast');
 for(const item of [paint,shader,child,img,snapshot,surface,fx])item.delete();
 console.log('PASS: photo shader compiles; face ROI, complexion and sharp facial features are preserved.');
})().catch(e=>{console.error(e);process.exit(1)});
