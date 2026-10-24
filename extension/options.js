const $ = id=>document.getElementById(id);
const UI_BUILD='0.1.0（司凤转发 15）';
let config, snapshot, friends=[],dirty=false,noticeTimer;
let friendDiagnosticBusy=false,friendReportAt=0,friendReportSeq=0,friendLocalReport=false;
async function api(type,fields={}) {
  const result=await chrome.runtime.sendMessage({type,...fields});
  if(!result?.ok) throw new Error(result?.error||'插件后台未响应，请重新加载扩展。');
  return result.data;
}
function notice(message,error=false) {
  clearTimeout(noticeTimer); const box=$('toast');box.textContent=message;box.className=error?'error':'';box.hidden=false;
  noticeTimer=setTimeout(()=>{box.hidden=true;},10000);
}
function el(tag,text,className) {const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;}
// Rhythm selects carry canonical values (seconds / minutes / count), so the
// label can say "1 个月" while storage stays an exact number.
function loadRhythm(cfg){
  for(const [id,value] of [['check-interval',Number(cfg.checkIntervalSeconds)||60],['video-window',Number(cfg.videoWindowMinutes)||60],['rate-max',Number(cfg.maxVideosPerWindow)||5]]){
    const select=$(id);const text=String(value);
    if(![...select.options].some(option=>option.value===text)){
      const option=document.createElement('option');option.value=text;option.textContent=text+'（旧值）';select.append(option);
    }
    select.value=text;
  }
}
// Two friends can share a nickname. The bound numeric uid is what actually
// identifies the recipient, so show its tail next to the name.
const friendLabel=friend=>friend.uid?`${friend.name}（UID 尾号 ${friend.uid.slice(-6)}）`:friend.name;
const time = at=>at?new Date(at).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'}):'尚未检查';
const list = text=>[...new Set(text.split(/[\n,，]/).map(x=>x.trim()).filter(Boolean))];
function recipientPicker(container,rule) {
  container.replaceChildren();
  const available=new Map([...rule.recipients,...friends].map(f=>[f.id,f]));
  for(const friend of available.values()) {
    const label=el('label',undefined,'recipient-choice');
    const input=el('input');input.type='checkbox';input.checked=rule.recipients.some(f=>f.id===friend.id);
    input.addEventListener('change',()=>{
      if(input.checked) rule.recipients.push(friend);
      else rule.recipients=rule.recipients.filter(f=>f.id!==friend.id);
      dirty=true;
    });
    label.append(input);
    if(/^https:\/\//.test(friend.avatar||'')){const img=el('img');img.src=friend.avatar;img.alt='';img.referrerPolicy='no-referrer';label.append(img);}
    label.append(el('span',friendLabel(friend)));container.append(label);
  }
}
function drawRules() {
  $('rules').replaceChildren();
  for(const rule of config.rules) {
    const node=$('rule-template').content.firstElementChild.cloneNode(true);
    const name=node.querySelector('.rule-name');name.value=rule.name;
    name.addEventListener('input',()=>{rule.name=name.value;dirty=true;});
    for(const field of ['tags','keywords']) {
      const input=node.querySelector(`.${field}`);input.value=rule[field].map(v=>typeof v==='string'?v:v.name).join('\n');
      input.addEventListener('input',()=>{rule[field]=list(input.value);dirty=true;});
    }
    node.querySelector('.remove-rule').addEventListener('click',()=>{
      config.rules=config.rules.filter(r=>r.id!==rule.id);dirty=true;drawRules();
    });
    recipientPicker(node.querySelector('.recipient-list'),rule);$('rules').append(node);
  }
}
function rows(id,items,render,emptyText) {
  const box=$(id);box.replaceChildren();
  if(!items.length) {box.textContent=emptyText;return;}
  for(const item of items) box.append(render(item));
}
function showFriendReport(report,{local=false}={}) {
  if(!report) return;
  const seq=Number(report.seq)||0;
  if(seq){
    if(seq<friendReportSeq || (seq===friendReportSeq&&friendLocalReport&&!local)) return;
    friendReportSeq=seq;
  } else if(!local&&(friendReportSeq>0||report.at<friendReportAt)) return;
  friendLocalReport=local;
  friendReportAt=report.at||Date.now();
  const info=report.diagnostics,first=info?.firstScreen;
  const partial=!!(info && (info.unrecognized || ['scan-limit','scroll-box-lost'].includes(info.stop)));
  $('friend-diagnostic').dataset.state=report.phase==='running'?'loading':report.error||partial?'error':'ready';
  for(const [id,value] of [['friend-first-observed',first?.controls],['friend-first-recognized',first?.recognized],['friend-first-rejected',first?.rejected]]) $(id).textContent=value??'—';
  const kinds={friends:'好友读取',diagnose:'分享面板诊断',run:'查询／发送',scan:'试检索'};
  const lines=['好友读取诊断 · 司凤转发 15',`时间：${time(report.at)}`,
    '报告版本：'+(report.build||'历史记录（未记录版本）'),'当前后台：'+(snapshot?.workerBuild||'未确认，请重新加载扩展'),
    '类型：'+(kinds[report.kind]||'历史报告')+'；状态：'+(report.phase==='running'?'进行中':report.error?'失败':'已结束')];
  if(report.error) {
    $('friend-diagnostic-status').textContent='本次操作失败，原因已保留在下面。';
    lines.push((['run','scan'].includes(report.kind)?'运行失败：':'读取失败：')+report.error);
  } else if(report.message) {
    $('friend-diagnostic-status').textContent=report.message;
    lines.push(report.message);
  } else if(!info) {
    $('friend-diagnostic-status').textContent=`本次读取 ${report.total} 位好友，但没有收到逐行诊断。请重新加载扩展并刷新本页后再试。`;
    lines.push('未返回逐行诊断；请在 edge://extensions 重新加载扩展，再刷新设置页。');
  } else {
    const stops={bottom:'已到列表底部','single-screen':'未发现滚动区','scan-limit':'达到扫描上限','scroll-box-lost':'滚动区中途消失'};
    const reasons={'invalid-uid':'UID 格式无效','name-missing':'未找到昵称','name-ambiguous':'昵称文本不唯一'};
    $('friend-diagnostic-status').textContent=`本次读取 ${report.total} 位好友。${partial?'仍有未识别或未扫完的项目，请复制下面的诊断结果。':'如仍有遗漏，请复制下面的诊断结果。'}`;
    lines.push(`读取版本：${info.revision}`,`首屏发现 ${first?.controls??'未知'} 个 UID 控件，识别 ${first?.recognized??'未知'}，跳过 ${first?.rejected??'未知'}`,
      `累计发现 ${info.observed}，识别 ${info.recognized}，未识别 ${info.unrecognized}`,`停止位置：${stops[info.stop]||info.stop}`);
    for(const [reason,count] of Object.entries(info.rejectionCounts||{})) lines.push(`跳过原因：${reasons[reason]||reason} ${count}`);
    lines.push('好友行脱敏结构：'+JSON.stringify(info.samples||[],null,2));
  }
  $('friend-diagnostic-output').value=lines.join('\n');
  $('copy-friend-diagnostic').disabled=false;
}
async function friendDiagnosticAction(fn) {
  if(friendDiagnosticBusy) throw new Error('正在读取好友，请等待本次完成。');
  friendDiagnosticBusy=true;
  const started=Date.now();
  $('friend-diagnostic').dataset.state='loading';
  $('friend-diagnostic-status').textContent='正在读取分享面板，请稍候；完成后结果会直接显示在这里。';
  $('friend-diagnostic-output').value='正在读取……';
  $('copy-friend-diagnostic').disabled=true;
  for(const id of ['friend-first-observed','friend-first-recognized','friend-first-rejected']) $(id).textContent='—';
  try {await fn(started);}
  catch(error) {
    let latest;
    try {latest=(await refresh()).state.friendReadReport;} catch {}
    if(latest&&(Number(latest.seq)>friendReportSeq||latest.at>=started)) showFriendReport(latest);
    else showFriendReport({at:Date.now(),error:error.message||String(error)},{local:true});
    throw error;
  }
  finally {friendDiagnosticBusy=false;}
}
function drawStatus(data) {
  snapshot=data;const state=data.state;
  $('runtime-version').textContent=data.workerBuild===UI_BUILD?'后台 '+data.workerBuild:'后台 '+(data.workerBuild||'版本未知')+'，请重新加载扩展';
  const running=state.enabled&&!state.paused;
  const queueOnly=state.runMode==='queue-only';
  $('send-pending').disabled=!!data.busy||running;
  $('status').textContent=state.paused?'需要处理':running?(queueOnly?'发送待发视频':data.busy?'运行中':'监控中'):'已暂停';
  $('status').className=`pill ${state.paused?'error':running?'running':''}`;
  $('run-title').textContent=state.paused?'先处理，再继续。':running?(queueOnly?'正在发送待发视频。':'正在留意新内容。'):'准备好，再出发。';
  $('run-description').textContent=queueOnly?'只发送已有结果，不重新查询；结束后保持暂停。':data.busy?'正在检索或转发；暂停会在当前单次操作结束后生效。':running?'每分钟检查一次，符合规则的视频会按发现顺序发送。':'完成配置后开始，或先试检索查看结果。';
  $('pending-count').textContent=state.deliveries.filter(d=>d.status==='pending').length;
  $('sent-count').textContent=state.deliveries.filter(d=>d.status==='sent').length;
  $('last-scan').textContent=time(state.lastScanAt);
  $('scan-warning').textContent=state.scanWarning||'';
  $('account-name').textContent=data.config.account?.name||'尚未绑定账号';
  $('account-detail').textContent=data.config.account?`账号标识 ${data.config.account.id}`:'先登录，再识别并绑定当前账号';
  $('incident').hidden=!state.paused;
  $('incident-reason').textContent=state.incident?.reason||'请核对待确认的发送记录。';
  $('mail-error').textContent=state.incident?.mailError||(state.incident?.notified?'告警邮件已交给邮件服务发送。':'');
  rows('uncertain',state.deliveries.filter(d=>d.status==='unknown'),d=>{
    const row=el('div',undefined,'list-row error');row.append(el('p',`视频 ${d.video.id} → ${d.recipient.name}`),el('small',d.error||'发送结果未确认'));
    const actions=el('div',undefined,'actions');
    for(const [action,label] of [['sent','核对后标记已发送'],['retry','确认未发送，重试'],['skip','跳过这位好友']]) {
      const button=el('button',label,'secondary');button.addEventListener('click',()=>run(button,async()=>{await api('RESOLVE',{key:d.key,action});await refresh();}));actions.append(button);
    }row.append(actions);return row;
  },'目前没有需要核对的记录');
  rows('preview',state.preview||[],v=>{
    const row=el('div',undefined,'list-row');const a=el('a',v.description||v.title||`视频 ${v.id}`);a.href=`https://www.douyin.com/video/${v.id}`;a.target='_blank';a.rel='noopener noreferrer';
    row.append(a,el('p',(v.tags||[]).map(t=>`#${t.name}`).join(' ')),el('small',`发布时间 ${time(v.publishedAt)}`));return row;
  },'命中的新视频会显示在这里');
  rows('logs',state.logs||[],entry=>{
    const row=el('div',undefined,`list-row ${entry.level==='error'?'error':''}`);row.append(el('small',time(entry.at)),el('p',entry.message||entry.reason||''));return row;
  },'尚无运行记录');
  if(!friendDiagnosticBusy) showFriendReport(state.friendReadReport);
}
async function refresh(loadConfig=false) {
  const data=await api('STATUS');
  if(loadConfig || !config) {
    config=structuredClone(data.config);$('max-pages').value=String(config.maxPages||3);$('mail-token').value=config.mailBridgeToken||'';loadRhythm(config);dirty=false;drawRules();
    if(!friends.length){const saved=new Set(config.rules.flatMap(r=>r.recipients.map(f=>f.id)));if(saved.size)$('friends-summary').textContent='规则中已保存 '+saved.size+' 位接收好友。可重新读取分享面板补充好友。';}
  }
  drawStatus(data);return data;
}
async function run(button,fn) {button.disabled=true;try{await fn();}catch(error){notice(error.message,true);}finally{button.disabled=button.id==='send-pending'&&snapshot?!!snapshot.busy||(snapshot.state.enabled&&!snapshot.state.paused):false;}}
function click(id,fn){$(id).addEventListener('click',()=>run($(id),fn));}
async function save() {
  config.maxPages=Number($('max-pages').value);config.mailBridgeToken=$('mail-token').value.trim();
  config.checkIntervalSeconds=Number($('check-interval').value);config.videoWindowMinutes=Number($('video-window').value);config.maxVideosPerWindow=Number($('rate-max').value);
  await api('SAVE',{config});dirty=false;await refresh(true);notice('设置已保存。');
}
click('open-login',()=>api('OPEN_LOGIN'));
click('bind',async()=>{if(dirty)await save();const account=await api('BIND');await refresh(true);notice(`已绑定 ${account.name}。`);});
click('load-friends',()=>friendDiagnosticAction(async()=>{
  const result=await api('FRIENDS');const found=Array.isArray(result)?result:result.friends;
  const latest=(await refresh()).state.friendReadReport;
  if(latest&&(Number(latest.seq)>friendReportSeq||latest.at>=friendReportAt)) showFriendReport(latest);
  else showFriendReport({at:Date.now(),total:found?.length||0,diagnostics:result.diagnostics},{local:true});
  if(!found?.length) throw new Error('没有识别到分享好友，请确认原生分享面板已加载。');
  friends=[...new Map([...friends,...found].map(f=>[f.id,f])).values()];
  const box=$('friends-summary');box.replaceChildren();
  for(const f of friends)box.append(el('span',friendLabel(f),'friend-chip'));
  const partial=result.diagnostics && (result.diagnostics.unrecognized || ['scan-limit','scroll-box-lost'].includes(result.diagnostics.stop));
  drawRules();notice(partial?'读取完成，发现遗漏，请查看按钮下方的“好友读取诊断”。':`已读取 ${friends.length} 位可见好友；诊断结果在按钮下方。`,!!partial);
}));
click('diagnose',()=>friendDiagnosticAction(async(started)=>{
  const result=await api('DIAGNOSE');const data=await refresh();
  const bad=(result.report||[]).filter(item=>!item.ok);
  if(data.state.friendReadReport&&(Number(data.state.friendReadReport.seq)>friendReportSeq||data.state.friendReadReport.at>=started)) showFriendReport(data.state.friendReadReport);
  else showFriendReport({at:Date.now(),error:bad.map(item=>item.text).join('\n')||'没有收到逐行诊断，请重新加载扩展并刷新本页。'},{local:true});
  notice('诊断结果已显示在按钮下方。',bad.length>0);
}));
click('copy-friend-diagnostic',async()=>{
  const output=$('friend-diagnostic-output');
  try {await navigator.clipboard.writeText(output.value);notice('诊断结果已复制，可粘贴到聊天中。');}
  catch {output.focus();output.select();notice('诊断结果已选中，请按 Ctrl+C 复制。');}
});
click('add-rule',async()=>{config.rules.push({id:crypto.randomUUID(),name:`规则 ${config.rules.length+1}`,tags:[],keywords:[],recipients:[]});dirty=true;drawRules();});
click('save',save);
click('start',async()=>{if(dirty)await save();await api('START');notice('已开启监控。');await refresh();});
click('send-pending',async()=>{if(dirty)await save();await api('SEND_PENDING');notice('正在发送待发视频，不重新查询；结束后保持暂停。');await refresh();});
click('pause',async()=>{await api('PAUSE');notice('已暂停；正在发送的单次操作会先完成。');await refresh();});
click('scan',async()=>{if(dirty)await save();notice('正在试检索，不会发送消息。');const result=await api('SCAN');await refresh();const minutes=Number(config.videoWindowMinutes)||60;notice(`试检索完成：命中 ${result.count} 个视频（窗口 ${minutes} 分钟）。详细数量见“运行记录”。`);});
click('mail-health',async()=>{if(dirty)await save();await api('MAIL_HEALTH');$('mail-status').textContent='邮件服务已配置。请另行发送测试邮件验证投递。';notice('邮件服务已连接。');});
click('mail-test',async()=>{if(dirty)await save();await api('MAIL_TEST');notice('测试邮件已交给邮件服务器，请检查收件箱。');});
click('export',async()=>{
  if(snapshot.state.enabled&&!snapshot.state.paused)throw new Error('切换运行位置前，请先暂停旧实例。');
  const backup=await api('EXPORT');const url=URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:'application/json'}));
  const a=el('a');a.href=url;a.download=`dead-mom-sharing-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);
});
click('import',async()=>{
  if(snapshot.state.enabled&&!snapshot.state.paused)throw new Error('请先暂停监控。');
  $('import-file').click();
});
$('import-file').addEventListener('change',async(event)=>{
  try{
    const file=event.target.files[0];if(!file)return;
    const backup=JSON.parse(await file.text());await api('IMPORT',{backup});await refresh(true);notice('备份已导入；请核对账号、配置邮件服务后再启动。');
  }catch(error){notice(error.message,true);}finally{event.target.value='';}
});
for(const id of ['max-pages','mail-token','check-interval','video-window','rate-max']){
  const node=$(id);
  node.addEventListener('input',()=>{dirty=true;});
  node.addEventListener('change',()=>{dirty=true;});
}
window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
refresh(true).catch(error=>notice(error.message,true));
setInterval(()=>refresh().catch(()=>{}),4000);
