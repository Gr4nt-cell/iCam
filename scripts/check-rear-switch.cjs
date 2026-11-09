const fs=require('fs'),vm=require('vm'),ts=require('typescript'),assert=require('assert/strict');
const code=ts.transpileModule(fs.readFileSync('src/ui/RearCamera.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText;
function hook(locked=false){
 let display={currentId:0,shizukuGranted:true,rootGranted:false,displays:[{id:0,isRear:false},{id:2,isRear:true}]};
 const moves=[],states=[],notices=[];let index=0,finish;
 let result={moved:true};
 const react={useState:v=>{const i=index++;return[v,v=>states.push({i,v})]},useRef:v=>({current:v}),useCallback:f=>f,useEffect:()=>{}};
 const native={getCameraDisplays:async()=>display,moveCameraDisplay:async(...args)=>{moves.push(args);return await new Promise(resolve=>{finish=()=>resolve(result)})}};
 const context={exports:{},setTimeout:f=>{f();return 0},require:name=>{
  if(name==='react')return react;
  if(name==='react-native')return {StyleSheet:{create:x=>x},useWindowDimensions:()=>({width:393,height:852})};
  if(name==='../../modules/icamera')return native;
  return {};
 }};
 vm.runInNewContext(code,context);
 const screens=context.exports.useCameraScreens(locked,v=>notices.push(v));
 return {screens,moves,states,notices,setDisplay:v=>display=v,setResult:v=>result=v,finish:()=>finish()};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
 const h=hook();const first=h.screens.toggleScreen();await tick();
 assert.equal(h.moves.length,1);assert.equal(h.moves[0][0],2,'First tap goes straight to the rear display');
 const second=h.screens.toggleScreen();await tick();assert.equal(h.moves.length,1,'Rapid taps cannot start overlapping moves');
 h.finish();await Promise.all([first,second]);assert(!h.states.some(x=>x.i===1&&x.v===true),'Successful switch must not open the chooser');
 h.setDisplay({currentId:2,shizukuGranted:false,rootGranted:true,displays:[{id:0,isRear:false},{id:2,isRear:true}]});
 const back=h.screens.toggleScreen();await tick();assert.equal(h.moves[1][0],0);assert.equal(h.moves[1][2],true,'Return reuses existing root access');h.finish();await back;
 const blocked=hook(true);await blocked.screens.toggleScreen();assert.equal(blocked.moves.length,0);
 const fail=hook();fail.setResult({moved:false,message:'Access required'});const failed=fail.screens.toggleScreen();await tick();fail.finish();await failed;
 assert(fail.states.some(x=>x.i===1&&x.v===true),'Access help opens only after an unsuccessful move');
 assert(fail.states.some(x=>x.i===2&&x.v===false),'Failed move must release the switching state');
 const module=fs.readFileSync('modules/icamera/android/src/main/java/expo/modules/icamera/ICameraModule.kt','utf8');
 assert(module.includes('target,privileged,root) { appContext.currentActivity }'));
 const ui=fs.readFileSync('modules/icamera/android/src/main/java/expo/modules/icamera/UiRefresh.kt','utf8');
 assert(ui.includes('attributes.preferredRefreshRate=target')&&ui.includes('setRequestedFrameRate(target)')&&ui.includes('if(view is ICameraView)return'));
 assert(!ui.includes('setTargetFrameRate')&&!ui.includes('preferredDisplayModeId'));
 console.log('PASS: direct rear/front switching, duplicate-tap guard, access fallback, recovery, current-activity verification and UI-only refresh request.');
})().catch(e=>{console.error(e);process.exit(1)});
