/* Static regression audit: requires the base revision as argv[2] (default HEAD). */
const fs=require('fs'),cp=require('child_process'),ts=require('typescript'),assert=require('assert/strict');
const base=process.argv[2]||'HEAD';
const files=['App.tsx','src/ui/Controls.tsx','src/ui/GlassSegmented.tsx','src/ui/ProPanel.tsx','src/ui/Sheets.tsx'];
const printer=ts.createPrinter({removeComments:true});
function parse(code,file){return ts.createSourceFile(file,code,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);}
function normalized(node,source){return printer.printNode(ts.EmitHint.Unspecified,node,source);}
let handlers=0;
for(const file of files){
 const before=cp.execFileSync('git',['show',`${base}:${file}`],{encoding:'utf8'}),after=fs.readFileSync(file,'utf8');
 function attrs(code){const src=parse(code,file),list=[];function walk(n){if(ts.isJsxAttribute(n)&&(/^on[A-Z]/.test(n.name.text)||['disabled','value','min','max','items','modes','stops','options'].includes(n.name.text)))list.push(normalized(n,src));ts.forEachChild(n,walk);}walk(src);return list;}
 const current=attrs(after);for(const old of attrs(before)){const i=current.indexOf(old);assert(i>=0,`${file}: lost or changed control binding ${old}`);current.splice(i,1);handlers++;}
 if(file==='App.tsx'){
  assert.equal(after.slice(0,after.indexOf('  if (perms.camera === null)')),before.slice(0,before.indexOf('  if (perms.camera === null)')),'Camera state, capture, processing or recording logic changed');
  function camera(code){const src=parse(code,file);let out;function walk(n){if(ts.isJsxSelfClosingElement(n)&&n.tagName.getText(src)==='ICameraView')out=normalized(n,src);ts.forEachChild(n,walk);}walk(src);return out;}
  assert.equal(camera(after),camera(before),'Native camera props changed');
 }
}
for(const path of ['modules','src/camera','src/processing','src/settings.ts'])assert.equal(cp.execFileSync('git',['diff',base,'--',path],{encoding:'utf8'}),'',`${path}: backend changed`);
console.log(`PASS: ${handlers} existing control bindings preserved; camera state/capture logic, native props and processing backend unchanged.`);
