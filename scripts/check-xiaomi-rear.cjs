const fs=require('fs'),ts=require('typescript'),Module=require('module'),assert=require('assert/strict');
const filename=require('path').resolve('src/camera/rearLayout.ts');const m=new Module(filename,module);
m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,filename);
const {rearCameraFrame,cameraFocusPoint,mirrorPhoto}=m.exports;
for(const [w,h] of [[976,596],[400,244],[320,200],[280,400]]){
 const f=rearCameraFrame(w,h);assert.equal(f.left,0,'No unused left section on the rear display');
 assert(f.width>0&&f.left+f.width<=w);
 const rail=w-f.width;assert(rail>=54&&rail<=96);
 assert(f.width>=w-.34*w,'Most of the rear display must be live image');
 assert.deepEqual(cameraFocusPoint(1,1,w,h,true),{x:1,y:1},'The previously blank area must accept focus');
 assert.equal(cameraFocusPoint(f.width,h/2,w,h,true),null,'Control-rail boundary is outside the camera');
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
