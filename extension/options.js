const $ = id=>document.getElementById(id);
const UI_BUILD='0.2.4（告警标题显示原因）';
const mailEnabled=cfg=>typeof cfg?.mailAlertsEnabled==='boolean'?cfg.mailAlertsEnabled:!!cfg?.mailBridgeToken?.trim();
let config, snapshot, friends=[],dirty=false,noticeTimer;
let statusRequest=0,statusApplied=0,statusRevision=-1,statusRefreshTimer;
let friendDiagnosticBusy=false,friendReportAt=0,friendReportSeq=0,friendLocalReport=false;
const normalTitle=document.title;
let alertBlink, alertVisible=false;
function updateBrowserNotice(state) {
  const active=!!(state.paused&&(state.incident?.id||state.incident?.incidentId));
  const icon=$('tab-icon');
  if(active) {
    const reason=String(state.incident.reason||'').replace(/\s+/gu,' ').trim()||'需要人工处理';
    document.title='告警：（'+reason+'）';
  }
  if(active&&!alertBlink) {
    const paint=()=>{alertVisible=!alertVisible;icon.href=alertVisible?'icons/tab-alert.svg':'icons/tab.svg';};
    paint();alertBlink=setInterval(paint,900);
  } else if(!active) {
    clearInterval(alertBlink);alertBlink=null;alertVisible=false;
    icon.href='icons/tab.svg';document.title=normalTitle;
  }
  $('browser-alert-error').textContent=active&&state.browserAlert?.incidentId===(state.incident?.id||state.incident?.incidentId)?state.browserAlert.error||'':'';
}
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
// Local, static help only: opening it must never call the worker or save a draft.
const REGION_HELP={
  browserAlert:{title:'浏览器声音与红点提醒',intro:'真正异常暂停时播放一次叮咚，设置页标签图标闪烁红点，标题显示“告警：（具体原因）”；关闭设置页仍能发出声音，工具栏保留告警标记。',items:[
    ['试听提示音','只播放选定的本地叮咚声音，不发视频、不发邮件、不修改运行状态。'],
    ['提醒何时结束','同一告警不因刷新或邮件重试反复响；手动暂停不触发新提醒，处理问题并成功恢复后红点和工具栏标记清除。'],
    ['邮件与静音','和邮件开关独立，不改变抖音工作标签的静音。浏览器或系统禁止声音时看页面提示；标签页休眠可能延迟闪烁。']]},
  rhythm:{title:'运行参数',intro:'控制多久检查、找多新的视频，以及发送速度。三个选项改完后，都要点击“保存规则与设置”。',items:[
    ['检查间隔','周期监控的检查周期，也用于全自动循环没有新待发视频时的等待时间。可选 30 秒到 1 小时。'],
    ['新视频窗口','按视频发布时间筛选，例如 1 小时表示只接收最近 1 小时发布的视频。可选 5 分钟到 30 天，不是程序运行时长。'],
    ['不同视频发送上限','每个滚动 60 秒窗口内允许发送的不同视频数。同一视频给多位好友不重复占不同视频名额；达到上限自动等待再续发。']]},
  account:{title:'绑定专用账号',intro:'指定本插件实际操作的抖音账号。检索和发送前会重新核对账号，变化时暂停。',items:[
    ['打开抖音登录','打开抖音网页，由你本人完成登录和验证；请使用准备转发视频的账号。'],
    ['识别并绑定账号','读取当前浏览器已登录的账号并保存绑定。先核对显示的名称，再继续配置；不能靠手填名称绑定。']]},
  friends:{title:'选择接收好友',intro:'从抖音原生视频分享面板读取可识别的好友。读取完成后，还要在下方规则里勾选接收人并保存；读取本身不会发送。',items:[
    ['读取分享好友','先在同一浏览器打开一条可播放的抖音视频。插件展开分享面板并滚动读取好友，结果显示在本区和规则的“发送给”中。'],
    ['诊断分享面板','检查分享入口、面板和好友行，刷新下方诊断报告，用于排查读不到或漏读；不会发送卡片。'],
    ['好友身份','优先以数字 UID 确认，UID 尾号帮助区分同名好友。只选希望接收视频的对象；无法唯一匹配时任务会暂停。']]},
  diagnostic:{title:'好友读取诊断',intro:'显示最近一次好友读取、诊断或查询／发送任务的报告。类型和时间可以确认这份结果来自哪次操作。',items:[
    ['首屏发现／识别／跳过','仅对好友读取报告统计：发现的是 UID 控件数，识别的是成功读取数量，跳过项可在详情中查看原因；不代表发送数量。'],
    ['报告版本／当前后台','报告版本是生成该报告的版本；当前后台是现在运行的版本。代码更新后需重新加载扩展，再刷新设置页。'],
    ['复制诊断结果','复制下方脱敏诊断文字，便于反馈错误。剪贴板不可用时会选中文字，可按 Ctrl+C；没有报告时不可用。'],
    ['诊断详情','保留进度、错误、跳过原因或脱敏结构，可手动选中复制；它是报告显示区，不能在这里修改运行状态。']]},
  rules:{title:'设置订阅规则',intro:'每条规则独立配置话题、关键词和接收人。命中任意话题或关键词即可进入该规则的发送队列；同账号、视频、好友会去重。',items:[
    ['＋ 添加规则','新增一张规则卡片，可分别设置内容和接收好友。'],
    ['每个搜索词最多读取几页','限制单个搜索词的查询页数。达到上限可能还有未读取结果；增加页数会增加检索耗时。'],
    ['保存规则与设置','保存全部规则、接收好友、分页上限、顶部运行参数与邮件连接令牌。运行中要修改配置，请先暂停。'],
    ['规则卡片','右上角的问号解释名称、话题、关键词、好友勾选和删除按钮；编辑后记得保存。']]},
  rule:{title:'这条订阅规则',intro:'这张卡片定义“找到什么内容、发送给哪些好友”。它与其他规则分别匹配，最终队列会合并并去重。',items:[
    ['规则名称','仅用于自己辨认规则，不参与视频匹配。'],
    ['真实话题 tag','每行一个话题。视频必须实际关联该话题；文案恰好出现相同文字不算关联话题。'],
    ['文案关键词','每行一个，匹配标题或文案，任意一个命中即可；不检查评论、口播或字幕。话题与关键词之间也是“任意命中”。'],
    ['发送给','勾选该规则的接收好友。可以选多人，未勾选的好友不会因这条规则接收视频。'],
    ['删除','移除这张规则卡片，保存后生效；不会删除历史发送记录或让已发视频重新发送。']]},
  control:{title:'运行控制',intro:'这里的启动按钮会按已保存的账号和规则执行。工作窗口自动后台最大化并静音；前三种启动方式可能实际发送卡片，“试检索”只查不发。',items:[
    ['全自动循环（抓取 → 发送）','自动抓取、发完本批、再抓下一批，直到你暂停或出现需处理的错误；没有新任务时按检查间隔等待。'],
    ['开始／恢复监控','按检查间隔持续检索并发送命中内容；有未完成批次时优先恢复保存的进度。'],
    ['发送待发视频（不查询）','使用已有队列和仍有效的上轮缓存，不重新搜索。限速自动等待，全部处理完后停止；已确认发送的不重发。'],
    ['暂停','停止后续查询和发送并取消自动续发计划。已按下发送的当前操作仍需确认，暂停不能撤回已经发出的卡片。'],
    ['试检索，不发送','按规则查询并展示本轮结果，不发送。查询分段时再次点击可继续；启动发送前可先用它核对规则。'],
    ['等待发送／本轮已发送卡片','等待发送是剩余好友任务数；本轮已发送只统计当前轮次新确认成功的卡片，同视频给 3 人算 3 张。自动续段与限速等待不清零。'],
    ['最近检查与等待状态','最近检查只在完整查询完成后更新。等待限速仍在运行，无需重复启动；验证码、账号变化、回执不明会暂停并告警。']]},
  mail:{title:'邮件告警（可选）',intro:'邮件提醒是可选功能。关闭时无需配置邮箱或启动邮件服务，仍可抓取和转发；真正异常仍会暂停并在页面提示。',items:[
    ['启用邮件告警','新安装默认关闭；旧版已有连接令牌会保留启用状态。打开后需要配置并连接本地邮件服务，改完点击“保存规则与设置”生效。手动暂停不会触发告警。'],
    ['邮件服务连接令牌','填写与本地邮件服务一致的连接令牌，编辑后保存。这里不是邮箱密码或邮箱授权码。'],
    ['检查邮件服务','检查连接、令牌和服务是否已配置；不会发送邮件，也不能证明邮件实际投递成功。'],
    ['发送测试邮件','实际发送一封测试邮件，请到收件箱核对。显示已交给服务器仍不等于已经收件。']]},
  transfer:{title:'切换运行位置',intro:'用于迁移配置与发送记录。先暂停旧实例，避免两个实例同时发送。备份可能包含账号、好友和视频记录，请妥善保管。',items:[
    ['导出备份','下载当前已保存配置和发送记录的 JSON 备份。未保存的编辑请先保存；备份不包含抖音登录会话和邮件连接令牌。'],
    ['导入备份','选择备份 JSON 文件，替换当前配置与记录。先导出当前备份以便保留；导入后保持停止，核对账号并重新登录，只有启用邮件告警时才需要配置服务。']]},
  review:{title:'待核对的发送',intro:'这里的记录可能已经发送成功。请亲自查看目标好友聊天记录，再处理；插件不会自动重试未知结果。',items:[
    ['核对后标记已发送','仅在确认好友已收到这条视频时使用，保留防重记录，并按原轮次计数。'],
    ['确认未发送，重试','仅在确认未发送且仍希望发送时使用，将该任务放回待发队列。之后仍需手动启动或恢复。'],
    ['跳过这位好友','放弃这条视频对该好友的任务，不代表发送成功，也不会跳过其他好友。'],
    ['处理后恢复','全部待核对项处理完后，再选择对应启动按钮继续；仅点击处理按钮不会自动开始发送。']]},
  discoveries:{title:'本轮发现',intro:'展示当前轮次的检索结果或待发清单，不会一直累加历史发现。自动续段会保留同一轮结果与统计。',items:[
    ['查询进度与阶段','查看已完成搜索词、总数和当前是否等待续查／续发。零结果会明确显示；查询失败保留已经找到的部分结果。'],
    ['视频标题／链接','点击在新标签页打开视频供本人核对；不会因为点开链接自动发送。'],
    ['已发送／待发／待核对','按好友卡片任务计数；“此前已发送”与本轮新发送分开，待核对不算发送成功。'],
    ['失效跳过','明确识别“你要观看的视频不存在”等提示后跳过剩余好友任务并继续队列；此数量不计成功，不是视频总数。'],
    ['显示范围','最多展示前 100 个视频，标题处仍显示完整发现数量。待发直发会注明不重新查询。']]},
  logs:{title:'运行记录',intro:'保存最近 200 条运行记录，用于查看查询、入队、发送、等待、跳过和报错原因。它是进度记录，不是待发队列。',items:[
    ['时间与文字','按记录时间检查最近发生的动作；红色条目表示错误。出现异常时可结合诊断报告反馈。'],
    ['记录更新','运行过程中自动更新，本区没有发送、重试或清空按钮。记录数量不等于本轮发送数量；成功数量以运行控制为准。']]}
};
let helpTrigger=null,helpPanel=null,helpHideTimer;
function closeHelp(){
  clearTimeout(helpHideTimer);
  if(helpTrigger)helpTrigger.removeAttribute('aria-describedby');
  helpTrigger=null;
  if(helpPanel)helpPanel.hidden=true;
}
function positionHelp(){
  if(!helpTrigger||!helpPanel)return;
  const anchor=helpTrigger.getBoundingClientRect(),gap=10,edge=12;
  if(anchor.bottom<=0||anchor.top>=window.innerHeight){closeHelp();return;}
  const width=Math.min(440,window.innerWidth-edge*2);
  helpPanel.style.width=width+'px';
  const below=Math.max(0,window.innerHeight-anchor.bottom-gap-edge),above=Math.max(0,anchor.top-gap-edge);
  const down=below>=Math.min(300,above);
  helpPanel.style.maxHeight=Math.min(560,down?below:above)+'px';
  helpPanel.style.left=Math.max(edge,Math.min(anchor.right-width,window.innerWidth-width-edge))+'px';
  const height=helpPanel.getBoundingClientRect().height;
  helpPanel.style.top=Math.max(edge,down?anchor.bottom+gap:anchor.top-gap-height)+'px';
}
function showHelp(button,key){
  clearTimeout(helpHideTimer);
  const help=REGION_HELP[key];if(!help)return;
  if(!helpPanel){
    helpPanel=el('div',undefined,'region-help-tooltip');helpPanel.id='region-help-tooltip';
    helpPanel.setAttribute('role','tooltip');helpPanel.hidden=true;document.body.append(helpPanel);
    helpPanel.addEventListener('mouseenter',()=>clearTimeout(helpHideTimer));
    helpPanel.addEventListener('mouseleave',event=>{if(event.relatedTarget!==helpTrigger)closeHelp();});
  }
  if(helpTrigger!==button){
    closeHelp();helpTrigger=button;
    const heading=el('h3',help.title),intro=el('p',help.intro),hint=el('p','长说明可滚动阅读 · Esc 关闭','region-help-hint'),items=el('dl');
    for(const [label,description] of help.items)items.append(el('dt',label),el('dd',description));
    helpPanel.replaceChildren(heading,intro,hint,items);helpPanel.scrollTop=0;
    button.setAttribute('aria-describedby',helpPanel.id);
  }
  helpPanel.hidden=false;positionHelp();
}
function attachHelp(region,key){
  if(!REGION_HELP[key]||region.querySelector(':scope > .region-help-button'))return;
  region.classList.add('has-region-help');
  const button=el('button','?','region-help-button');button.type='button';
  button.setAttribute('aria-label',REGION_HELP[key].title+'：功能与按钮说明');
  button.addEventListener('mouseenter',()=>showHelp(button,key));
  button.addEventListener('focus',()=>{
    button.scrollIntoView({block:'nearest',inline:'nearest'});
    showHelp(button,key);
  });
  button.addEventListener('click',()=>showHelp(button,key));
  // A short bridge lets the pointer cross the gap to read/scroll the panel.
  button.addEventListener('mouseleave',event=>{if(!helpPanel?.contains(event.relatedTarget))helpHideTimer=setTimeout(closeHelp,120);});
  button.addEventListener('blur',()=>{if(helpTrigger===button)closeHelp();});
  region.append(button);
}
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeHelp();});
document.addEventListener('pointerdown',event=>{
  if(helpTrigger&&!helpTrigger.contains(event.target)&&!helpPanel.contains(event.target))closeHelp();
});
window.addEventListener('resize',closeHelp);
window.addEventListener('scroll',event=>{if(!helpPanel?.contains(event.target))positionHelp();},true);
for(const region of document.querySelectorAll('[data-help]'))attachHelp(region,region.dataset.help);
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
  if(helpTrigger&&$('rules').contains(helpTrigger))closeHelp();
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
    attachHelp(node,'rule');recipientPicker(node.querySelector('.recipient-list'),rule);$('rules').append(node);
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
  const lines=['好友读取诊断 · v0.2.4',`时间：${time(report.at)}`,
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
function updateMailControls(data){
  if(!data)return;
  const selected=$('mail-alerts-enabled').checked,saved=mailEnabled(data.config);
  const running=data.busy||(data.state.enabled&&!data.state.paused);
  $('mail-alerts-enabled').disabled=!!running;
  for(const id of ['mail-token','mail-health','mail-test'])$(id).disabled=!selected||!!running;
  const status=$('mail-status');
  if(!selected)status.textContent='邮件告警已关闭，无需配置邮箱或启动邮件服务。'+(saved?'保存后生效。':'');
  else if(!saved)status.textContent='邮件告警将启用，请配置邮件服务并保存设置。';
  else if(status.dataset.mailEnabled!=='true'||status.dataset.mailSaved!=='true')status.textContent='邮件服务：尚未检查';
  status.dataset.mailEnabled=String(selected);
  status.dataset.mailSaved=String(saved);
}
function drawStatus(data) {
  snapshot=data;const state=data.state;
  updateBrowserNotice(state);
  $('runtime-version').textContent=data.workerBuild===UI_BUILD?'后台 '+data.workerBuild:'后台 '+(data.workerBuild||'版本未知')+'，请重新加载扩展';
  const running=state.enabled&&!state.paused;
  const queueOnly=state.runMode==='queue-only',autoLoop=state.runMode==='auto-loop';
  const plan=running?state.resumePlan:null;
  const seconds=plan?Math.max(0,Math.ceil((plan.at-Date.now())/1000)):0;
  const wait=plan?seconds?`预计 ${seconds} 秒后自动继续`:'即将自动继续':'';
  for(const id of ['send-pending','auto-loop','start','scan'])$(id).disabled=!!data.busy||running;
  $('status').textContent=state.paused?'需要处理':running?(plan?.reason==='rate-limit'?'等待限速':
    plan?.reason==='next-round'?'等待下一轮':autoLoop?'全自动循环':queueOnly?'发送待发视频':data.busy?'运行中':'监控中'):'已暂停';
  $('status').className=`pill ${state.paused?'error':running?'running':''}`;
  $('run-title').textContent=state.paused?'先处理，再继续。':running?(plan?.reason==='rate-limit'?'正在等限速解除。':
    autoLoop?'全自动循环进行中。':queueOnly?'正在发送待发视频。':'正在留意新内容。'):'准备好，再出发。';
  $('run-description').textContent=plan?`任务仍在运行，${wait}。${queueOnly?'只发送剩余队列，不重新查询。':
    plan.reason==='next-round'?'本轮已发完，将开始下一轮抓取。':'先发完已有队列，再继续查询。'}`:
    queueOnly?'只发送已有结果；限速自动等待，直到队列发完，不重新查询。':autoLoop?'抓取 → 发送 → 发完再抓取；限速自动等待，直到暂停或出错。':
    data.busy?'正在检索或转发；暂停会在当前单次操作结束后生效。':running?'按检查间隔继续查询，符合规则的视频会按发现顺序发送。':'完成配置后开始，或先试检索查看结果。';
  $('pending-count').textContent=state.deliveries.filter(d=>d.status==='pending').length;
  const round=state.round;
  $('sent-count').textContent=round?.id?state.deliveries.filter(d=>d.status==='sent'&&d.attemptRoundId===round.id).length:0;
  $('last-scan').textContent=time(state.lastScanAt);
  $('scan-warning').textContent=state.scanWarning||'';
  $('account-name').textContent=data.config.account?.name||'尚未绑定账号';
  $('account-detail').textContent=data.config.account?`账号标识 ${data.config.account.id}`:'先登录，再识别并绑定当前账号';
  $('incident').hidden=!state.paused;
  $('incident-reason').textContent=state.incident?.reason||'请核对待确认的发送记录。';
  $('mail-error').textContent=mailEnabled(data.config)?state.incident?.mailError||(state.incident?.notified?'告警邮件已交给邮件服务发送。':''):'邮件告警已关闭；后续不发送邮件。';
  updateMailControls(data);
  rows('uncertain',state.deliveries.filter(d=>d.status==='unknown'),d=>{
    const row=el('div',undefined,'list-row error');row.append(el('p',`视频 ${d.video.id} → ${d.recipient.name}`),el('small',d.error||'发送结果未确认'));
    const actions=el('div',undefined,'actions');
    for(const [action,label] of [['sent','核对后标记已发送'],['retry','确认未发送，重试'],['skip','跳过这位好友']]) {
      const button=el('button',label,'secondary');button.addEventListener('click',()=>run(button,async()=>{await api('RESOLVE',{key:d.key,action});await refresh();}));actions.append(button);
    }row.append(actions);return row;
  },'目前没有需要核对的记录');
  const roundStatus={running:'进行中',done:'已结束',failed:'失败',paused:'已暂停',interrupted:'已中断'};
  const foundCount=Number(round?.foundCount)||0;
  const roundSource=round?.source==='search'?'本轮检索':round?.source==='resume'?'续发当前队列（不重新查询）':'待发直发（不重新查询）';
  const progress=round?.source==='search'?`；查询 ${round.queriesDone||0}/${round.queriesTotal||0}`:'';
  const stages={searching:'正在查询',sending:'正在发送已发现的视频', 'waiting-rate':'等待限速解除，随后自动续发','waiting-next-round':'本轮已发完，等待下一轮抓取','waiting-send':'等待自动续发剩余队列', 'waiting-search':'队列已发完，将自动继续剩余查询'};
  const stage=(round?.status==='running'||running&&round?.stage==='waiting-next-round')&&stages[round.stage]?`；${stages[round.stage]}${round.stage==='waiting-send'&&round.queriesDone<round.queriesTotal?'，发完再继续查询':''}`:'';
  $('round-summary').textContent=round?`${time(round.startedAt)} 开始 · ${roundSource} · ${roundStatus[round.status]||'已结束'}${progress}${stage}；${round.source==='search'?'发现':'待发清单'} ${foundCount} 个视频${foundCount>100?'（展示前 100 个）':''}。${round.scanStatus==='incomplete'?'查询未完成，下面保留已找到的结果。':''}${round.stopReasonText?'结束原因：'+round.stopReasonText+'。':''}${round.error?'本轮错误：'+round.error:''}`:'尚未开始新一轮。试检索可查看结果；发送待发视频可使用已有队列和上轮缓存。';
  const emptyPreview=!round?'开始新一轮后，结果会显示在这里':round.status==='running'?(round.source==='search'?'正在查询，找到的视频会逐步显示在这里。':'本轮暂无可展示的待发视频。'):round.status==='failed'?'本轮未取得结果，请查看上方错误和运行记录。':round.status==='paused'?'本轮已暂停，尚未取得结果。':round.source==='search'?'本轮未发现符合规则及时间窗口的视频。':'本轮没有待发视频。';
  rows('preview',round?.videos||[],v=>{
    const row=el('div',undefined,'list-row');const a=el('a',v.description||v.title||`视频 ${v.id}`);a.href=`https://www.douyin.com/video/${v.id}`;a.target='_blank';a.rel='noopener noreferrer';
    const related=state.deliveries.filter(d=>d.video.id===v.id&&String(d.accountId)===String(data.config.account?.id));
    const sent=related.filter(d=>d.status==='sent'&&d.attemptRoundId===round.id).length;
    const previous=related.filter(d=>d.status==='sent'&&d.attemptRoundId!==round.id).length;
    const skipped=related.filter(d=>d.status==='skipped'&&d.skipReason==='video-unavailable').length;
    const pending=related.filter(d=>['pending','sending'].includes(d.status)).length;
    const unknown=related.filter(d=>d.status==='unknown').length;
    row.append(a,el('p',(v.tags||[]).map(t=>`#${t.name}`).join(' ')),el('small',`发布时间 ${time(v.publishedAt)}`),el('p',`本轮已发送 ${sent} 张 · 待发 ${pending} 张${skipped?' · 失效跳过 '+skipped+' 项':''}${unknown?' · 待核对 '+unknown+' 张':''}${previous?' · 此前已发送 '+previous+' 张':''}`));return row;
  },emptyPreview);
  rows('logs',state.logs||[],entry=>{
    const row=el('div',undefined,`list-row ${entry.level==='error'?'error':''}`);row.append(el('small',time(entry.at)),el('p',entry.message||entry.reason||''));return row;
  },'尚无运行记录');
  if(!friendDiagnosticBusy) showFriendReport(state.friendReadReport);
}
async function refresh(loadConfig=false) {
  const request=++statusRequest;
  const data=await api('STATUS');
  const revision=Number(data.state.statusRevision)||0;
  if(request<statusApplied||revision<statusRevision) return snapshot||data;
  statusApplied=request;statusRevision=revision;
  if(loadConfig || !config) {
    config=structuredClone(data.config);$('max-pages').value=String(config.maxPages||3);$('mail-token').value=config.mailBridgeToken||'';$('mail-alerts-enabled').checked=mailEnabled(config);loadRhythm(config);dirty=false;drawRules();
    if(!friends.length){const saved=new Set(config.rules.flatMap(r=>r.recipients.map(f=>f.id)));if(saved.size)$('friends-summary').textContent='规则中已保存 '+saved.size+' 位接收好友。可重新读取分享面板补充好友。';}
  }
  drawStatus(data);return data;
}
async function run(button,fn) {button.disabled=true;try{await fn();}catch(error){notice(error.message,true);}finally{button.disabled=['send-pending','auto-loop','start','scan'].includes(button.id)&&snapshot?!!snapshot.busy||(snapshot.state.enabled&&!snapshot.state.paused):false;}}
function click(id,fn){$(id).addEventListener('click',()=>run($(id),fn));}
async function save() {
  config.maxPages=Number($('max-pages').value);config.mailBridgeToken=$('mail-token').value.trim();
  config.mailAlertsEnabled=$('mail-alerts-enabled').checked;
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
click('send-pending',async()=>{if(dirty)await save();await api('SEND_PENDING');notice('正在发送待发视频；限速自动等待，全部发完后停止，不重新查询。');await refresh();});
click('auto-loop',async()=>{if(dirty)await save();await api('AUTO_LOOP');notice('已开启全自动循环：抓取、发送、发完再抓取；限速自动等待。');await refresh();});
click('pause',async()=>{await api('PAUSE');notice('已暂停；正在发送的单次操作会先完成。');await refresh();});
click('preview-alert',async()=>{await api('BROWSER_ALERT_TEST');notice('已播放叮咚提示音；未发送视频或邮件。');});
click('scan',async()=>{if(dirty)await save();notice('正在试检索，不会发送消息。');const result=await api('SCAN');await refresh();const minutes=Number(config.videoWindowMinutes)||60;notice(result.cancelled?`试检索已暂停，本轮已找到 ${result.count} 个视频。`:result.partial?`本段试检索完成：查询 ${result.queriesDone}/${result.queriesTotal}，命中 ${result.count} 个视频。再次点击试检索继续，不会发送。`:`试检索完成：命中 ${result.count} 个视频（窗口 ${minutes} 分钟）。详细数量见“运行记录”。`);});
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
    const backup=JSON.parse(await file.text());await api('IMPORT',{backup});await refresh(true);notice('备份已导入；请核对账号和邮件告警开关后再启动。');
  }catch(error){notice(error.message,true);}finally{event.target.value='';}
});
for(const id of ['max-pages','mail-token','mail-alerts-enabled','check-interval','video-window','rate-max']){
  const node=$(id);
  node.addEventListener('input',()=>{dirty=true;});
  node.addEventListener('change',()=>{dirty=true;if(id==='mail-alerts-enabled')updateMailControls(snapshot);});
}
window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
refresh(true).catch(error=>notice(error.message,true));
chrome.storage?.onChanged?.addListener((changes,area)=>{
  if(area!=='local'||(!changes.state&&!changes.config)) return;
  clearTimeout(statusRefreshTimer);
  statusRefreshTimer=setTimeout(()=>refresh().catch(()=>{}),100);
});
setInterval(()=>refresh().catch(()=>{}),4000);
