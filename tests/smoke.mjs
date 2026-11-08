import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

const html=await readFile('index.html');
const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end(html)});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://commons.wikimedia.org/w/api.php?**',route=>{
   const query=new URL(route.request().url()).searchParams.get('srsearch');
   if(query==='Updated species filetype:video')return route.abort();
   return route.fulfill({json:{query:{searchinfo:{totalhits:query==='Horned crab filetype:video'?0:3}}}});
 });
 await page.goto(url);
 await page.getByRole('button',{name:'+ New species'}).click();
 await page.locator('#common').fill('Horned crab');
 await page.locator('#latin').fill('Testus example');
 assert.match(await page.locator('#heading').innerText(),/Horned crab/);
 assert.equal(await page.getByRole('navigation',{name:'Clip pages'}).getByRole('button').count(),7);
 assert.equal(await page.getByRole('heading',{name:'Find stock footage'}).isVisible(),false);
 await page.getByRole('button',{name:/Clip 6/}).click();
 const stock=page.locator('#footageSearch');
 assert.equal(await stock.isVisible(),true);
 for(const [label,term] of [['common name','Horned crab'],['scientific name','Testus example']]){
   const href=await stock.getByRole('link',{name:new RegExp(label)}).getAttribute('href');
   const search=new URL(href);
   assert.equal(search.hostname,'commons.wikimedia.org');
   assert.equal(search.searchParams.get('ns6'),'1');
   assert.equal(search.searchParams.get('search'),term+' filetype:video');
 }
 await stock.getByText('No videos found',{exact:true}).waitFor();
 await stock.getByText('3 videos found',{exact:true}).waitFor();
 await page.locator('#latin').fill('Updated species');
 assert.match(await stock.getByRole('link',{name:/scientific name/}).innerText(),/Updated species/);
 await stock.getByText('Couldn’t check the count',{exact:true}).waitFor();
 await page.getByRole('button',{name:'← Projects'}).click();
 assert.match(await page.locator('#projects').innerText(),/0\/6 clips complete/);
 await page.getByRole('button',{name:'Filming queue'}).click();
 assert.match(await page.locator('#queueItems').innerText(),/Species introduction/);
 await page.getByRole('button',{name:'← Projects'}).click();
 await page.getByRole('button',{name:'Open project'}).click();
 assert.equal(await page.locator('#common').inputValue(),'Horned crab');
 const seekResult=await page.evaluate(async()=>{
   const video={currentTime:0,readyState:1,seeking:false,error:null};
   await seekVideo(video,0);
   await seekVideo(video,0.05);
   video.currentTime=0;
   Object.defineProperty(video,'currentTime',{get(){return this._time||0},set(value){this._time=value;this.seeking=true;setTimeout(()=>{this.seeking=false},30)}});
   await seekVideo(video,2.5);
   return video.currentTime;
 });
 assert.equal(seekResult,2.5);
 assert.equal(await page.getByRole('checkbox',{name:'Clip complete'}).isDisabled(),true);
 await page.getByRole('button',{name:'← Projects'}).click();
 assert.match(await page.locator('#nextAction').innerText(),/Record Species introduction for #1 Horned crab/);
 await page.getByRole('button',{name:'Go to next step'}).click();
 assert.match(await page.locator('#clipTabs [aria-current=true]').innerText(),/Species introduction/);
 await page.getByRole('checkbox',{name:/Posted to Instagram/}).check();
 assert.equal(await page.locator('#projects section').count(),0);
 await page.reload();
 assert.match(await page.locator('#projectCount').innerText(),/0 active projects/);
 await page.getByText('Archive (1)',{exact:true}).click();
 await page.getByRole('button',{name:'Restore project'}).click();
 assert.match(await page.locator('#projects').innerText(),/Horned crab/);
 assert.deepEqual(errors,[]);
 console.log('PASS: app boot, species CRUD, seven clip pages, filming queue, persistence, no JS errors');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
