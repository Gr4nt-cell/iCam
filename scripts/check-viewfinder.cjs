const fs=require('fs'),vm=require('vm'),ts=require('typescript'),assert=require('assert/strict');
const file='src/camera/viewfinder.ts';
const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
const context={exports:{}};vm.runInNewContext(code,context);
const {cameraViewport,restoreStabilization}=context.exports;
let cases=0;
for(const [w,h,top,bottom] of [[393,852,28,24],[360,800,24,24],[320,568,24,16],[852,393,0,24]]){
 for(const [video,aspect,ratio] of [[true,'4:3',9/16],[false,'4:3',3/4],[false,'16:9',9/16],[false,'1:1',1],[false,'full',3/4]]){
  const f=cameraViewport(w,h,video,aspect,top,bottom);
  assert(Math.abs(f.width/f.height-(w>h?1/ratio:ratio))<1e-8,'Capture ratio must match the visible frame');
  assert(f.left>=0&&f.top>=0&&f.left+f.width<=w+.001);
  if(video){assert.equal(f.left,0);assert.equal(f.width,w>h?w-184:w,'Video must fill the available width without side bars')}
  else assert(f.top>=top&&f.top+f.height<=h-bottom+.001);
  if(!video&&w<=h)assert(f.top+f.height<=h-bottom-160,'Compact shutter and modes must fit outside the image');
  else if(w>h)assert(f.left+f.width<=w-184+.001,'Landscape controls need a separate rail');
  cases++;
 }
}
assert.equal(restoreStabilization('horizon'),'cinematic');
assert.equal(restoreStabilization('off'),'off');
assert.equal(restoreStabilization('standard'),'standard');
const app=fs.readFileSync('App.tsx','utf8'),sheet=fs.readFileSync('src/ui/Sheets.tsx','utf8');
assert(app.includes('...viewport')&&app.includes('frameSize={viewport}'));
assert(app.includes('x + (L.rear ? 0 : L.frame.left)')&&app.includes('y + (L.rear ? 0 : L.frame.top)'),'Focus ring must follow camera-local focus coordinates');
const menu=app.slice(app.indexOf('captureControls={'),app.indexOf('photo={photo}'));
for(const name of ['Timer','Video light','Exposure','Filters and skin','setTimer','setFlash','ToneSliders','LookPanel','ProPanel'])assert(menu.includes(name),name+' must be available in settings');
assert(sheet.includes('{p.captureControls}'));
assert(!app.includes('HORIZON')&&!sheet.includes("'horizon'")&&!app.includes('styles.quickActions'));
const native=fs.readFileSync('modules/icamera/android/src/main/java/expo/modules/icamera/ICameraView.kt','utf8');
assert(native.includes('Recorder.Builder()\n      .setAspectRatio(androidx.camera.core.AspectRatio.RATIO_16_9)'),'Every regular recorder must request the displayed video ratio');
assert(native.includes('val outAspect = if(width>height) 16f/9f else 9f/16f'),'Dual composition must use the same visible video ratio');
assert(app.indexOf('style={styles.topMetaChip}')>app.indexOf('style={styles.topPill}'));
assert(app.indexOf('style={styles.topMetaChip}')<app.indexOf('style={styles.instrumentCluster}'));
assert(app.includes('minWidth: 60, maxWidth: 100')&&app.includes('height: 36, gap: 0'));
assert(app.includes('Math.max(win.height - viewport.top - viewport.height + 12, deckHeight + 12)'));
assert(app.includes("backgroundColor: isVideoMode ? 'transparent' : '#000'"));
const controls=fs.readFileSync('src/ui/Controls.tsx','utf8');
assert(controls.includes('height={28}')&&controls.includes('minItemWidth={30}'));
assert(controls.includes('width: 64, height: 64')&&controls.includes('width: 44, height: 44'));
console.log(`PASS: ${cases} capture-ratio layouts, square crop, compact controls, moved settings and legacy setting migration.`);
