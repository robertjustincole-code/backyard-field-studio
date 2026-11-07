import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { readFile, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

const dir=await mkdtemp(join(tmpdir(),'bfs-export-'));
const clip=join(dir,'sample.mp4');
const ff=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x568:rate=15','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','1.2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest','-y',clip],{encoding:'utf8'});
if(ff.status!==0)throw Error('ffmpeg failed: '+ff.stderr);
const html=await readFile('index.html');
const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end(html)});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});
try{
 const page=await browser.newPage({acceptDownloads:true});
 page.on('console',m=>console.log('browser:',m.type(),m.text()));
 page.on('pageerror',e=>console.error('PAGE ERROR:',e.message));
 await page.goto('http://127.0.0.1:'+server.address().port);
 await page.getByRole('button',{name:'+ New species'}).click();
 const inputs=page.locator('#segments input[type=file]');
 for(const i of [0,1,2,3,5,6])await inputs.nth(i).setInputFiles(clip);
 await page.waitForFunction(()=>Object.keys(JSON.parse(localStorage.getItem('bfs_projects'))[0].clips).length===6);
 await page.waitForTimeout(1500);
 await page.getByRole('button',{name:'Stitch video'}).click();
 await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Export complete')||document.querySelector('#status').textContent.includes('Render failed'),null,{timeout:90000});
 const status=await page.locator('#status').innerText();
 assert.match(status,/Export complete/,status);
 const link=page.locator('#download a');assert.equal(await link.count(),1);
 const download=await Promise.all([page.waitForEvent('download'),link.click()]).then(x=>x[0]);
 const path=await download.path();const info=await stat(path);
 assert.ok(info.size>10000,'Output video too small');
 const probe=spawnSync('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1',path],{encoding:'utf8'});
 assert.equal(probe.status,0,probe.stderr);
 console.log('PASS: stitched 6 real clips into playable video',info.size,'bytes',probe.stdout.trim());
}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
