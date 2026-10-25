// Actual Chromium adapter and visibility; synthetic text only, no puzzle answers.
// All network requests are intercepted. No account, sends or SMTP.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { browserTask } from '../extension/adapter.js';

const instruction='请选择所有符合上文描述的图片，并拖拽到下方';
const shell=`<section role="dialog"><h2>虚构验证题目</h2><p>${instruction}</p><div>拖拽到这里</div><button>提交</button></section>`;
const browser=await chromium.launch({headless:true,executablePath:process.env.BOT_TEST_CHROMIUM||undefined});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  await page.route('**/*',route=>route.request().url()==='https://www.douyin.com/search/test'?
    route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><html><body><main>虚构搜索页</main></body></html>'}):route.abort());
  await page.goto('https://www.douyin.com/search/test');
  await page.addScriptTag({content:`window.runAdapter=(${browserTask.toString()});`});
  await page.evaluate(shell=>{document.body.innerHTML=shell;window.clicks=0;document.onclick=()=>window.clicks++;},shell);
  let result=await page.evaluate(()=>window.runAdapter({action:'search',query:'test',captureErrors:true}));
  assert.equal(result.code,'SECURITY_CHALLENGE');
  assert.equal(await page.evaluate(()=>window.clicks),0);
  await page.evaluate(({shell,instruction})=>{
    document.body.innerHTML=`<div hidden>${shell}</div><div><article><p>${instruction}</p></article></div>`;
    window.fetch=async()=>({ok:true,json:async()=>({status_code:0,data:[],has_more:0})});
  },{shell,instruction});
  result=await page.evaluate(()=>window.runAdapter({action:'search',query:'test',captureErrors:true}));
  assert.equal(result.payloads.length,1);
  for(const stage of ['fetch','json','frame']) {
    await page.evaluate(({shell,stage})=>{
      document.body.innerHTML='<main>虚构搜索页</main>';
      window.clicks=0;window.requestAborted=false;
      const frame=stage==='frame'?document.body.appendChild(document.createElement('iframe')):null;
      const stall=signal=>new Promise((_,reject)=>{
        signal.addEventListener('abort',()=>{window.requestAborted=true;reject(new Error('fixture aborted'));},{once:true});
        setTimeout(()=>{
          if(frame)frame.contentDocument.body.innerHTML=shell;
          else document.body.insertAdjacentHTML('beforeend',shell);
        },60);
      });
      window.fetch=(_url,{signal})=>stage==='json'?Promise.resolve({ok:true,json:()=>stall(signal)}):stall(signal);
    },{shell,stage});
    const started=Date.now();
    result=await page.evaluate(()=>window.runAdapter({action:'search',query:'test',captureErrors:true}));
    assert.equal(result.code,'SECURITY_CHALLENGE',stage);
    assert.match(result.error,/图片拖拽安全验证/u);
    assert.ok(Date.now()-started<3000,'must interrupt instead of waiting for the HTTP timeout');
    assert.equal(await page.evaluate(()=>window.requestAborted),true);
    assert.equal(await page.evaluate(()=>window.clicks),0);
  }
  await mkdir(new URL('../test-results/',import.meta.url),{recursive:true});
  await page.screenshot({path:fileURLToPath(new URL('../test-results/search-challenge-smoke.png',import.meta.url))});
  console.log('PASS: Chromium static/dynamic image-verification detection, pending fetch/body abort, accessible frame polling, hidden/content exclusions and zero clicks. Synthetic data only.');
} finally {await browser.close();}
