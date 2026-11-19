const fs=require('fs'),ts=require('typescript'),Module=require('module'),assert=require('assert/strict');
const filename=require('path').resolve('src/camera/rearLayout.ts');const m=new Module(filename,module);
m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,filename);
const {rearCameraFrame,cameraFocusPoint,mirrorPhoto}=m.exports;
for(const [w,h] of [[976,596],[400,244],[320,200],[280,400]]){
 const f=rearCameraFrame(w,h);assert.equal(f.left,w>h?Math.round(w*.30):0,'The live image starts right of the lenses on a landscape rear display');
 assert(f.width>0&&f.left+f.width<=w);
 const rail=w-f.left-f.width;assert(rail>=58&&rail<=110);
 assert(f.width>=w*.40 && f.left+f.width<=w-58,'The live image fills the space between the lenses and the control rail');
 assert.deepEqual(cameraFocusPoint(1,1,w,h,true),w>h?null:{x:1,y:1},'Taps under the lenses are not camera taps');
 assert.equal(cameraFocusPoint(f.left+f.width,h/2,w,h,true),null,'Control-rail boundary is outside the camera');
 assert.deepEqual(cameraFocusPoint(f.left+f.width/2,h/2,w,h,true),{x:f.width/2,y:h/2});
 assert.equal(cameraFocusPoint(w-1,h/2,w,h,true),null,'Toolbar taps are outside the camera');
}
for(const facing of ['front','back']){
 assert(mirrorPhoto(facing,false,true,0));assert(mirrorPhoto(facing,false,true));
 assert(!mirrorPhoto(facing,true,true,1),'Never mirror an already mirrored photo twice');
}
assert(!mirrorPhoto('back',true,false,0));assert(!mirrorPhoto('front',false,false,0));
const app=fs.readFileSync('App.tsx','utf8');
assert(app.includes("previewFit={!screens.onSecondary && (!isPhotoShot || aspect !== '1:1')}"));
assert(app.includes('filter, aspectRatio, bokeh, captureReq'),'Preview fill must not change saved-photo aspect');
const manifest=fs.readFileSync('modules/icamera/android/src/main/AndroidManifest.xml','utf8');
assert(manifest.includes('android.permission.MANAGE_ACTIVITY_TASKS'));
const router=fs.readFileSync('modules/icamera/android/src/main/java/expo/modules/icamera/RearDisplayRouter.kt','utf8');
assert(router.includes('if(systemAccess(activity))'));
assert(router.includes('if(useRoot)'));
console.log('PASS: Xiaomi rear geometry, local focus, mirrored photo policy and optional access routes.');
