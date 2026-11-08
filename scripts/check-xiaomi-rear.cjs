const fs=require('fs'),ts=require('typescript'),Module=require('module'),assert=require('assert/strict');
const filename=require('path').resolve('src/camera/rearLayout.ts');const m=new Module(filename,module);
m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,filename);
const {rearCameraFrame,cameraFocusPoint,mirrorPhoto}=m.exports;
for(const [w,h] of [[976,596],[400,244],[320,200],[280,400]]){
 const f=rearCameraFrame(w,h);assert(f.left>=0&&f.width>0&&f.left+f.width<=w);
 assert.deepEqual(cameraFocusPoint(f.left+f.width/2,h/2,w,h,true),{x:f.width/2,y:h/2});
 assert.equal(cameraFocusPoint(w-1,h/2,w,h,true),null,'Toolbar taps are outside the camera');
}
for(const facing of ['front','back']){
 assert(mirrorPhoto(facing,false,true,0));assert(mirrorPhoto(facing,false,true));
 assert(!mirrorPhoto(facing,true,true,1),'Never mirror an already mirrored photo twice');
}
assert(!mirrorPhoto('back',true,false,0));assert(!mirrorPhoto('front',false,false,0));
const manifest=fs.readFileSync('modules/icamera/android/src/main/AndroidManifest.xml','utf8');
assert(manifest.includes('android.permission.MANAGE_ACTIVITY_TASKS'));
const router=fs.readFileSync('modules/icamera/android/src/main/java/expo/modules/icamera/RearDisplayRouter.kt','utf8');
assert(router.includes('if(systemAccess(activity))'));
assert(router.includes('if(useRoot)'));
console.log('PASS: Xiaomi rear geometry, local focus, mirrored photo policy and optional access routes.');
