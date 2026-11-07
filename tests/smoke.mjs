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
 await page.goto(url);
 await page.getByRole('button',{name:'+ New species'}).click();
 await page.locator('#common').fill('Horned crab');
 await page.locator('#latin').fill('Testus example');
 assert.match(await page.locator('#heading').innerText(),/Horned crab/);
 assert.equal(await page.locator('#segments section').count(),7);
 await page.getByRole('button',{name:'← Projects'}).click();
 assert.match(await page.locator('#projects').innerText(),/0\/6 required clips/);
 await page.getByRole('button',{name:'Filming queue'}).click();
 assert.match(await page.locator('#queueItems').innerText(),/Species introduction/);
 await page.getByRole('button',{name:'← Projects'}).click();
 await page.getByRole('button',{name:'Open project'}).click();
 assert.equal(await page.locator('#common').inputValue(),'Horned crab');
 assert.deepEqual(errors,[]);
 console.log('PASS: app boot, species CRUD, seven slots, filming queue, persistence, no JS errors');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
