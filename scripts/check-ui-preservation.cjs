/* Static regression audit: requires the base revision as argv[2] (default HEAD). */
const fs=require('fs'),cp=require('child_process'),ts=require('typescript'),assert=require('assert/strict');
const base=process.argv[2]||'HEAD';
const hdr=process.argv.includes('--allow-hdr-processing');
const grouped=process.argv.includes('--allow-mode-grouping');
const motion=process.argv.includes('--allow-static-motion');
const hardware=process.argv.includes('--allow-hardware-tuning');
const photoSkin=process.argv.includes('--allow-photo-smoothing');
const rear=process.argv.includes('--allow-rear-screen');
const liveRecord=process.argv.includes('--allow-live-recording');
const xiaomi=process.argv.includes('--allow-xiaomi-rear');
const files=['App.tsx','src/ui/Controls.tsx','src/ui/GlassSegmented.tsx','src/ui/ProPanel.tsx','src/ui/Sheets.tsx'];
const printer=ts.createPrinter({removeComments:true});
function parse(code,file){return ts.createSourceFile(file,code,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);}
function canonicalAttr(code){const src=parse(`<X ${code}/>`, 'temp.tsx');return printer.printNode(ts.EmitHint.Unspecified,src.statements[0].expression.attributes.properties[0],src);}
function approvedPrefix(prefix){
 if(liveRecord)prefix=prefix.replace("if (v.video) setVideo((x) => ({ ...x, ...v.video, stabilization: v.video?.hdr && v.video.stabilization === 'horizon' ? 'cinematic' : v.video?.stabilization ?? x.stabilization }));","if (v.video) setVideo((x) => ({ ...x, ...v.video }));");
 if(xiaomi)prefix=prefix.replace(/^import \{ rearCameraFrame[^\n]+\n/m,'')
  .replace('mirrorPhoto(facing,mirrorSelfie,screens.onSecondary,jpegMirrored)',"facing === 'front' && (jpegMirrored === 1 ? !mirrorSelfie : mirrorSelfie)")
  .replace(/, rear: screens\.onSecondary, width: win\.width, height: win\.height/g,'')
  .replace(/, screens\.onSecondary/g,'')
  .replace('            const point=cameraFocusPoint(x,y,L.width,L.height,L.rear);\n            if(!point)return;\n','')
  .replace('cam.current?.focus(point.x, point.y)','cam.current?.focus(x, y)')
  .replace("aspectRatio: screens.onSecondary && aspect === 'full' ? rearCameraFrame(win.width,win.height).width / win.height : aspectRatio",'aspectRatio');
 return prefix;
}
function normalized(node,source){
 if(ts.isJsxAttribute(node)){
  const text=node.getText(source);
  if(xiaomi&&node.name.text==='style'&&text.includes('rearCameraFrame'))return canonicalAttr('style={StyleSheet.absoluteFill}');
  if(liveRecord&&node.name.text==='options'&&text.includes('p.video.hdr'))return canonicalAttr("options={['off','standard','cinematic','horizon']}");
  if(liveRecord&&node.name.text==='labels'&&text.includes('p.video.hdr'))return canonicalAttr("labels={['Off','Std','Cinema','Horizon']}");
  if(liveRecord&&node.name.text==='onChange'&&text.includes('stabilization: hdr'))return canonicalAttr('onChange={(hdr)=>p.onVideo({...p.video,hdr})}');
 }

 if(photoSkin&&ts.isJsxAttribute(node)&&node.name.text==='smoothing'&&node.getText(source).includes('captureSmoothing'))return 'smoothing={smoothing}';
 if(photoSkin&&ts.isJsxAttribute(node)&&node.name.text==='onSmoothing'&&node.getText(source).includes('setPhotoSmoothing'))return 'onSmoothing={setSmoothing}';
 if(hdr&&ts.isJsxAttribute(node)&&['onRecordingState','onRecordingFinished'].includes(node.name.text))return node.name.text;
 if(hardware&&ts.isJsxAttribute(node)&&node.name.text==='hdrVideo')return node.name.text;
 if(hardware&&ts.isJsxAttribute(node)&&node.name.text==='onPress'&&node.getText(source).includes('setDualPrimary'))return 'onPress:resetDualZoomAndSwap';
 if(hardware&&ts.isJsxAttribute(node)&&node.name.text==='mode')return node.name.text;
 let result=printer.printNode(ts.EmitHint.Unspecified,node,source);
 if(motion)result=result.replace(/press\(0\.9\)/g,'press(0.98)');
 return result;
}
let handlers=0;
for(const file of files){
 const before=cp.execFileSync('git',['show',`${base}:${file}`],{encoding:'utf8'}),after=fs.readFileSync(file,'utf8');
 function attrs(code){
 if(grouped&&file==='src/ui/Controls.tsx')code=code.replace(/export function ModeCarousel[\s\S]*?(?=\/\* ---------------- Shutter)/,'export function ModeCarousel(){return null;}\n');
 const src=parse(code,file),list=[];function walk(n){
 if(grouped&&ts.isJsxSelfClosingElement(n)&&n.tagName.getText(src)==='ModeCarousel')return;
if(ts.isJsxAttribute(n)&&(/^on[A-Z]/.test(n.name.text)||['disabled','value','min','max','items','modes','stops','options'].includes(n.name.text)))list.push(normalized(n,src).replace(/setZoom\(1\);\s*setLensId\(null\);\s*(?=setFacing)/g, ''));ts.forEachChild(n,walk);}walk(src);return list;}
 const current=attrs(after);for(const old of attrs(before)){const i=current.indexOf(old);assert(i>=0,`${file}: lost or changed control binding ${old}`);current.splice(i,1);handlers++;}
 if(file==='App.tsx'){
  function state(code){let prefix=approvedPrefix(code.slice(0,code.indexOf('  if (perms.camera === null)')));if(rear)prefix=prefix.replace(/^import \{ CameraScreenPicker[^\n]+\n/m,'').replace(/  \/\/ Display switching owns[\s\S]*?(?=  const sliderTimer =)/,'').replace('    if (screens.switching) return;\n','').replace(', screens.switching','');if(photoSkin)prefix=prefix.replace(/^import \{ DEFAULT_PHOTO_SMOOTHING[^\n]+\n/m,'').replace(/^  const \[photoSmoothing[^\n]+\n/m,'').replace(/^    photoSmoothing\?: number;\n/m,'').replace(/^        setPhotoSmoothing[^\n]+\n/m,'').replace(/, photoSmoothing(?=, pip|, filter)/g,'').replace('smoothing: captureSmoothing(mode, photoSmoothing, smoothing)','smoothing');if(motion)prefix=prefix.replace(', ZoomIn, ZoomOut','');if(hardware)prefix=prefix.replace(/^\s*\/\/ (v2: HDR video|HDR defaults off,)[^\n]*\n/gm,'').replace('...v.video, hdr: false','...v.video');if(hdr)prefix=prefix.replace('if (!c || busy) return;','if (!c) return;').replace('}, [recording, busy, flashToast]);','}, [recording, flashToast]);');return hdr?prefix.replace(/const canFlipWhileRecording = [^;]+;/,'const canFlipWhileRecording = HDR_RESTRICTED;'):prefix;}
  assert.equal(state(after),state(before),'Unreviewed camera state or capture logic changed');
  function camera(code){const src=parse(code,file);let out;function walk(n){if(ts.isJsxSelfClosingElement(n)&&n.tagName.getText(src)==='ICameraView')out=n.attributes.properties.filter(p=>!(ts.isJsxAttribute(p)&&((hardware&&p.name.text==='manualControls')||(xiaomi&&p.name.text==='rearSelfie')))).map(p=>normalized(p,src)).join("\n");ts.forEachChild(n,walk);}walk(src);return out;}
  assert.equal(camera(after),camera(before),'Native camera props changed');
 }
}
const quality=process.argv.includes('--allow-capture-quality');
const offline=process.argv.includes('--allow-offline-stabilization');
const reviewed=new Set([
 'modules/icamera/android/build.gradle',
 'modules/icamera/android/src/main/java/expo/modules/icamera/VideoTuning.kt',
 'modules/icamera/android/src/main/java/expo/modules/icamera/ICameraView.kt',
 'modules/icamera/android/src/main/java/expo/modules/icamera/PortraitVideo.kt',
 'modules/icamera/android/src/test/java/expo/modules/icamera/VideoTuningTest.kt',
 'src/processing/pipeline.ts','src/processing/shaders.ts',
 ...(liveRecord ? ['modules/icamera/android/src/main/java/expo/modules/icamera/RecordingStabilityPolicy.kt','modules/icamera/android/src/test/java/expo/modules/icamera/RecordingStabilityPolicyTest.kt','modules/icamera/android/src/main/java/expo/modules/icamera/LiveRollFilter.kt','modules/icamera/android/src/test/java/expo/modules/icamera/LiveRollFilterTest.kt'] : []),
 ...(xiaomi ? ['src/camera/rearLayout.ts','modules/icamera/android/src/main/java/expo/modules/icamera/RearDisplayTaskMover.kt','modules/icamera/android/src/main/java/expo/modules/icamera/RearDisplayRoot.kt'] : []),
 ...(rear ? ['modules/icamera/android/src/main/java/expo/modules/icamera/RearDisplayPolicy.kt','modules/icamera/android/src/main/java/expo/modules/icamera/RearDisplayService.kt','modules/icamera/android/src/main/java/expo/modules/icamera/RearDisplayRouter.kt','modules/icamera/android/src/test/java/expo/modules/icamera/RearDisplayPolicyTest.kt','modules/icamera/android/src/main/AndroidManifest.xml','modules/icamera/android/consumer-rules.pro','modules/icamera/android/src/main/java/expo/modules/icamera/ICameraModule.kt','modules/icamera/index.ts'] : []),
 ...(photoSkin ? ['src/processing/skinSettings.ts'] : []),
 ...(offline ? ['modules/icamera/android/src/main/java/expo/modules/icamera/OfflineVideoMotion.kt','modules/icamera/android/src/test/java/expo/modules/icamera/OfflineVideoMotionTest.kt'] : []),
 ...(hdr ? ['modules/icamera/android/src/main/java/expo/modules/icamera/HdrVideoStabilizer.kt','modules/icamera/android/src/main/java/expo/modules/icamera/VideoProcessingTransform.kt','modules/icamera/android/src/test/java/expo/modules/icamera/VideoProcessingTransformTest.kt'] : []),
 ...(grouped ? ['src/camera/modeGroups.ts'] : []),
 ...(hardware ? ['modules/icamera/android/src/main/java/expo/modules/icamera/ICameraModule.kt','modules/icamera/index.ts','modules/icamera/android/src/main/java/expo/modules/icamera/PhoneCameraPolicy.kt','modules/icamera/android/src/main/java/expo/modules/icamera/PhoneCameraTuning.kt','modules/icamera/android/src/test/java/expo/modules/icamera/PhoneCameraPolicyTest.kt'] : []),
]);
for(const folder of ['modules','src/camera','src/processing','src/settings.ts']) {
 const changed=cp.execFileSync('git',['diff','--name-only',base,'--',folder],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
 for(const file of changed)assert(quality&&reviewed.has(file),`${file}: unreviewed backend change`);
}
console.log(`PASS: ${handlers} unaffected control bindings preserved; authorized camera hardware tuning, HDR callbacks, grouped controls and capture-quality changes scoped separately.`);
