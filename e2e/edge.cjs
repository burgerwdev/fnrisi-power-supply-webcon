// Boundary/defensive verification (needs proxy + real device; headless): invalid-input interception, automatic-task mutex, manual controls disabled while busy, language switching, tooltips.
const { chromium } = require('playwright');
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const RES=[];
const rec=(n,ok,d='')=>{RES.push({n,ok,d});console.log(`  [${ok?'PASS':'FAIL'}] ${n} ${d}`.trimEnd());};
const logText=(p)=>p.locator('#log').textContent().catch(()=> '');
async function waitLog(p,kw,ms){const t=Date.now()+ms;let l='';while(Date.now()<t){l=await logText(p);if(l.includes(kw))return true;await sleep(250);}return false;}
async function clickDlg(p,re){const b=p.locator('.dialog button',{hasText:re}).last();await b.waitFor({state:'visible',timeout:5000});await b.click();}
(async()=>{
  const b=await chromium.launch({headless:true,args:['--no-sandbox']});
  const p=await b.newPage();
  const errs=[];p.on('pageerror',e=>errs.push(e.message));p.on('console',m=>m.type()==='error'&&errs.push(m.text()));
  await p.goto('http://localhost:4173/?proxy=ws://127.0.0.1:8787',{waitUntil:'networkidle'});
  await p.click('#btn-connect');
  if(!(await waitLog(p,'已收到设备数据,连接正常',60000))){console.log('no device');process.exit(1);}
  await sleep(1200);

  // 1) Invalid input: immediate hint & not written
  await p.locator('#in-v').fill('99');
  await sleep(200);
  const hintV=(await p.locator('#hint-v').textContent()).trim();
  const invalidCls=await p.locator('#in-v').evaluate(el=>el.classList.contains('invalid'));
  rec('Invalid voltage (99>max) immediate hint + red border', invalidCls && hintV.includes('上限'), hintV.slice(0,60));
  await p.click('#btn-set'); await sleep(600);
  const after = await p.evaluate(()=>dps150.state.settings.voltageSet);
  rec('Invalid value not written to device', after!==undefined && after!==99, 'vset='+after);
  const logHas=(await logText(p)).includes('未写入设备');
  rec('Log says not written', logHas, '');
  await p.locator('#in-v').fill('0.5'); await p.locator('#in-a').fill('0.05');
  await p.click('#btn-set'); await sleep(800);

  // 2) Automatic-task mutex: while sequence runs, manual buttons disabled & scan start is blocked
  await p.click('button[data-tab="sequence"]'); await sleep(200);
  await p.locator('#tab-sequence textarea').fill('0.5, 0.02, 600\n1.0, 0.02, 600');
  await p.locator('#tab-sequence button',{hasText:'运行'}).click();
  await clickDlg(p,/开始运行/);
  await sleep(700);
  const setDisabled = await p.locator('#btn-set').isDisabled();
  const outDisabled = await p.locator('#btn-out').isDisabled();
  rec('While sequence runs: apply/output buttons disabled (gated)', setDisabled && outDisabled, '');
  await p.click('button[data-tab="scan"]'); await sleep(150);
  await p.locator('#tab-scan button',{hasText:'开始扫描'}).click(); await sleep(600);
  const busyDlg=await p.locator('.dialog h3').first().textContent().catch(()=> '');
  const runShown=await p.locator('.dialog',{hasText:'开始扫描'}).count();
  rec('While sequence runs: scan is politely blocked', busyDlg.includes('其他任务')&&runShown===0, busyDlg);
  await p.locator('.dialog button',{hasText:'知道了'}).click().catch(()=>{});
  // Wait for sequence to finish (~2s) and return to meter
  for(let i=0;i<30;i++){if((await logText(p)).includes('运行完成')||(await logText(p)).includes('完成:全部'))break;await sleep(300);}
  await sleep(500);
  await p.click('button[data-tab="meter"]'); await sleep(200);
  rec('Buttons restored after sequence ends', !(await p.locator('#btn-set').isDisabled()), '');

  // 3) Protection/mode lamp tooltip exists
  const protTip=await p.locator('#lamp-prot').getAttribute('title');
  const modeTip=await p.locator('#lamp-mode').getAttribute('title');
  rec('Protection/mode lamp has descriptive tooltip', (protTip&&protTip.length>4)&&(modeTip&&modeTip.length>4), (protTip||'').slice(0,40)+' | '+(modeTip||'').slice(0,40));

  // 4) Language switch zh→en→zh (a confirmation dialog pops up; click "Switch")
  const confirmLang = async () => {
    await p.locator('.dialog button').filter({ hasText: /切换|Switch/ }).first().click();
  };
  await p.click('#btn-lang'); await confirmLang(); await p.waitForLoadState('networkidle',{timeout:15000});
  await sleep(600);
  const tabEn=await p.locator('button[data-tab="meter"]').textContent();
  rec('Switch to English (tab=Meter)', (tabEn||'').trim()==='Meter', tabEn);
  await p.click('#btn-lang'); await confirmLang(); await p.waitForLoadState('networkidle',{timeout:15000});
  await sleep(600);
  const tabZh=await p.locator('button[data-tab="meter"]').textContent();
  rec('Switch back to Chinese (tab=仪表)', (tabZh||'').includes('仪表'), tabZh);

  // 5) Disconnect & cleanup
  await p.click('#btn-connect'); await waitLog(p,'已收到设备数据',30000);
  await p.click('#btn-disconnect'); await sleep(500);
  rec('No page errors throughout', errs.length===0, errs.slice(0,2).join('|'));
  const ok=RES.filter(r=>r.ok).length;
  console.log(`\n===== Boundary verification ${ok}/${RES.length} PASS =====`);
  for(const r of RES) if(!r.ok) console.log('  FAIL:',r.n,r.d);
  await b.close();
  process.exit(ok===RES.length?0:1);
})().catch(e=>{console.error('EDGE_CRASH',e);process.exit(2);});
