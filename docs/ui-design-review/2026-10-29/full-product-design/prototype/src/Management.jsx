import React, { useState } from 'react';
import { Btn, Icon, Tag, Panel, PageTitle, frames } from './ui.jsx';

const initialTasks = [
  { id: 'frame-04', name: '镜头 04 · 首帧', step: '制作关键帧', status: '等待前置素材', tone: 'neutral', object: '雨后的小插曲', account: '创作账号 01', hint: '相关基础图片还没有采用。确认所需素材后，再继续本镜头。', action: '查看所缺素材', group: 'running', icon: 'clock', activity: ['生成：未开始', '下载：未开始', '文件校验：未开始', '人工检查：未开始'] },
  { id: 'frame-03', name: '镜头 03 · 首帧', step: '制作关键帧', status: '待确认', tone: 'amber', object: '雨后的小插曲', account: '创作账号 01', hint: '已收到候选图片，请选择满意的一张。', action: '查看候选', group: 'attention', icon: 'image', activity: ['生成：已结束', '下载：已保存', '文件校验：通过', '人工检查：待确认'] },
  { id: 'video-02', name: '镜头 02 · 历史视频任务', step: '历史任务', status: '待核对', tone: 'amber', object: '雨后的小插曲', account: '创作账号 02', hint: '已发送，但暂时没有读到结果。请查看豆包会话后核对，避免重复生成。', action: '核对结果', group: 'attention', icon: 'warning', activity: ['生成：结果待核对', '下载：未开始', '文件校验：未开始', '人工检查：未开始'] },
  { id: 'asset-scene', name: '雨后村路 · 场景图', step: '准备基础素材', status: '需要登录', tone: 'amber', object: '雨后的小插曲', account: '创作账号 03', hint: '请在账号浏览器中完成登录，再继续这项任务。', action: '打开账号', group: 'attention', icon: 'team', activity: ['生成：等待登录', '下载：未开始', '文件校验：未开始', '人工检查：未开始'] },
  { id: 'download-01', name: '镜头 01 · 历史视频下载', step: '历史下载记录', status: '下载失败', tone: 'red', object: '雨后的小插曲', account: '创作账号 01', hint: '原视频已经生成，文件尚未保存成功。重新下载使用原产物。', action: '重新下载', group: 'attention', icon: 'download', activity: ['生成：已结束', '下载：失败', '文件校验：未开始', '人工检查：未开始'] },
  { id: 'video-01', name: '镜头 01 · 历史视频生成', step: '历史任务', status: '生成结束', tone: 'green', object: '雨后的小插曲', account: '创作账号 01', hint: '原任务已生成视频，下载失败。该记录不表示当前镜头成果已采用。', action: '查看详情', group: 'done', icon: 'video', activity: ['生成：已结束', '下载：失败', '文件校验：未开始', '人工检查：未开始'] },
];

export function Tasks({ notify, openModal, openChat, go, adoptedFrames = {} }) {
  const [tasks, setTasks] = useState(initialTasks);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState('video-02');
  const filters = [['all', '全部任务'], ['attention', '需要处理'], ['running', '等待与进行中'], ['done', '已结束操作']];
  const currentTasks = tasks.map(task => task.id === 'frame-03' && adoptedFrames['3:first'] !== undefined ? { ...task, status: '图片已采用', tone: 'green', group: 'done', hint: '已采用的首帧可以用于镜头 03。', action: '查看图片', activity: ['生成：已结束', '下载：已保存', '文件校验：通过', '人工检查：已采用'] } : task);
  const visible = currentTasks.filter(task => (filter === 'all' || task.group === filter) && `${task.name}${task.object}${task.account}`.includes(query));
  function act(task) {
    if (task.id === 'download-01' && task.status === '下载失败') {
      setTasks(items => items.map(item => item.id === task.id ? { ...item, status: '等待下载', tone: 'neutral', group: 'running', hint: '已加入下载队列，轮到后重新保存原视频。', action: '查看进度', activity: ['生成：已结束', '下载：等待中', '文件校验：未开始', '人工检查：未开始'] } : item));
      notify('已加入下载队列');
    } else if (task.id === 'frame-04') go('materials');
    else if (task.id === 'frame-03') {
      if (adoptedFrames['3:first'] !== undefined) openModal({ type: 'view', title: '镜头 3 · 首帧', target: '镜头 3 · 首帧', shot: 3, src: typeof adoptedFrames['3:first'] === 'string' ? adoptedFrames['3:first'] : frames[adoptedFrames['3:first']] });
      else openModal({ type: 'image', title: '选择满意的图片', target: '镜头 3 · 首帧', shot: 3 });
    } else if (task.status === '需要登录') go('accounts');
    else if (task.status === '待核对') openChat('镜头 02 的历史视频生成结果');
    else setExpanded(expanded === task.id ? null : task.id);
  }
  return <div className="stack">
    <PageTitle title="任务中心" subtitle="查看当前制作进度与历史任务，处理需要你关注的事项。" action={<Btn onClick={() => notify('任务状态已刷新')}><Icon name="refresh" />刷新</Btn>} />
    <Panel>
      <div className="row between"><div className="tabs" aria-label="任务筛选">{filters.map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}<span>{value === 'all' ? currentTasks.length : currentTasks.filter(item => item.group === value).length}</span></button>)}</div><label className="field"><Icon name="search" /><input aria-label="搜索任务" placeholder="搜索镜头、作品或账号" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
      <div className="notice"><Icon name="warning" /><span>有任务需要核对。已发送的任务请先查看结果，再决定下一步。</span></div>
      <table className="table"><thead><tr><th>任务</th><th>作品 / 阶段</th><th>账号</th><th>状态</th><th>操作</th></tr></thead><tbody>
        {visible.map(task => <React.Fragment key={task.id}><tr>
          <td><div className="row"><Icon name={task.icon} /><button className="text-button" onClick={() => setExpanded(expanded === task.id ? null : task.id)}>{task.name}</button></div></td>
          <td><div>{task.object}</div><small className="muted">{task.step}</small></td><td>{task.account}</td><td><Tag tone={task.tone}>{task.status}</Tag></td><td><Btn small onClick={() => act(task)}>{task.action}</Btn></td>
        </tr>{expanded === task.id && <tr className="task-detail"><td colSpan="5"><div className="stack"><div className="row"><Icon name="arrow" /><span>{task.hint}</span></div><div className="row" style={{ flexWrap: 'wrap' }}>{task.activity.map(activity => <Tag key={activity} tone="neutral">{activity}</Tag>)}</div></div></td></tr>}</React.Fragment>)}
      </tbody></table>
      {!visible.length && <div className="empty"><Icon name="search" /><p>没有找到符合条件的任务</p><Btn onClick={() => { setQuery(''); setFilter('all'); }}>查看全部</Btn></div>}
    </Panel>
    <p className="subtle">生成、下载、文件校验与人工检查分别记录。一次操作结束后，仍需检查对应成果。</p>
  </div>;
}

const fallbackMaterials = [{ name: '噜噜', type: '人物', img: 0, adopted: true }, { name: '噜妹', type: '人物', img: 1, adopted: true }, { name: '小伙伴', type: '人物', img: 2, adopted: false }];
const historyVideo = { id: 'history-video', name: '镜头 01 · 历史视频文件', target: '历史任务 / 镜头 01', type: 'video', category: 'downloads', status: '下载失败', tone: 'red', size: '文件待下载', check: '尚未获得本地文件', history: '原产物可重新下载，尚未作为当前镜头成果采用。' };

export function Library({ notify, openModal, materials = fallbackMaterials, adoptedFrames = { '1:first': 0 }, candidates = { '2:first': 1 }, src }) {
  const [tab, setTab] = useState('adopted');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('material-0');
  const [downloadQueued, setDownloadQueued] = useState(false);
  function queueDownload() { setDownloadQueued(true); notify('原视频文件已加入下载队列'); }
  const imageSrc = value => src ? src(value) : typeof value === 'string' ? value : frames[value % frames.length];
  const assets = materials.flatMap((material, index) => material.img === null || material.img === undefined ? [] : [{ id: `material-${index}`, name: `${material.name} · ${material.type}参考图`, target: `基础素材 / ${material.type}`, type: 'image', category: material.adopted ? 'adopted' : 'candidates', status: material.adopted ? '已采用' : '待确认', tone: material.adopted ? 'green' : 'amber', preview: imageSrc(material.img), imageIndex: material.img, material: index, modalTarget: `${material.name} · ${material.type}参考图`, size: 'PNG', check: '文件校验通过', history: material.adopted ? '当前采用图片 · 替换后保留历史版本' : '候选图片尚未用于后续制作' }]);
  Object.entries(adoptedFrames).forEach(([key, value]) => { const [shot, frameKind] = key.split(':'); assets.push({ id: `frame-${key}`, name: `镜头 ${shot} · ${frameKind === 'last' ? '尾帧' : '首帧'}`, target: `关键帧 / 镜头 ${shot}`, modalTarget: `镜头 ${shot} · ${frameKind === 'last' ? '尾帧' : '首帧'}`, type: 'image', category: 'adopted', status: '已采用', tone: 'green', preview: imageSrc(value), imageIndex: value, shot: Number(shot), frameKind, size: 'PNG', check: '文件校验通过', history: '当前采用图片 · 可查看历史版本' }); });
  Object.entries(candidates).forEach(([key, value]) => { if (adoptedFrames[key] !== undefined) return; const [shot, frameKind] = key.split(':'); assets.push({ id: `candidate-${key}`, name: `镜头 ${shot} · ${frameKind === 'last' ? '尾帧' : '首帧'}候选`, target: `关键帧 / 镜头 ${shot}`, modalTarget: `镜头 ${shot} · ${frameKind === 'last' ? '尾帧' : '首帧'}`, type: 'image', category: 'candidates', status: '待确认', tone: 'amber', preview: imageSrc(value), imageIndex: value, shot: Number(shot), frameKind, size: 'PNG', check: '文件校验通过', history: '确认前不会成为正式视频参考' }); });
  const tabs = [['adopted', '已采用图片'], ['candidates', '待确认图片'], ['videos', '镜头视频'], ['downloads', '下载记录']];
  const visible = (tab === 'downloads' ? [...assets, historyVideo] : assets.filter(asset => asset.category === tab)).filter(asset => `${asset.name}${asset.target}`.includes(query));
  const selected = visible.find(asset => asset.id === selectedId) || visible[0];
  function preview(asset) {
    const target = asset.modalTarget || asset.name;
    const association = asset.material !== undefined ? { material: asset.material } : { shot: asset.shot, frameKind: asset.frameKind };
    if (asset.category === 'candidates') openModal({ type: 'image', title: '选择满意的图片', target, ...association });
    else openModal({ type: 'view', title: asset.name, target, src: asset.preview, ...association });
  }
  return <div className="stack">
    <PageTitle title="素材与下载" subtitle="雨后的小插曲 · 已采用素材、候选图片与逐镜文件。" />
    <div className="row between"><div className="tabs">{tabs.map(([value, label]) => <button key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{label}</button>)}</div><label className="field"><Icon name="search" /><input placeholder="搜索素材" aria-label="搜索素材" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
    {tab === 'candidates' && <div className="notice"><Icon name="image" /><span>候选图片经过确认后才会用于制作。预览后，选择满意的一张。</span></div>}
    {tab === 'videos' ? <Panel><div className="empty"><Icon name="video" /><h3>尚无已保存的镜头视频</h3><p className="muted">完成镜头视频制作与下载后，可以在这里查看。</p></div><div className="list-row between"><div><strong>镜头 01 · 历史视频文件</strong><p className="muted">{downloadQueued ? '等待下载原产物；当前尚无可播放的本地文件。' : '原产物已生成，下载失败；当前没有可播放的本地文件。'}</p></div><Btn small disabled={downloadQueued} onClick={queueDownload}>{downloadQueued ? '等待下载' : '重新下载'}</Btn></div></Panel> : tab === 'downloads' ? <Panel><table className="table"><thead><tr><th>文件</th><th>对应对象</th><th>下载</th><th>文件校验</th><th>操作</th></tr></thead><tbody>{visible.map(asset => <tr key={asset.id}><td><div className="row"><Icon name={asset.type} />{asset.name}</div><small className="muted">{asset.size}</small></td><td>{asset.target}</td><td><Tag tone={asset.type === 'video' ? downloadQueued ? 'neutral' : 'red' : 'green'}>{asset.type === 'video' ? downloadQueued ? '等待下载' : '下载失败' : '已保存'}</Tag></td><td>{asset.check}</td><td><Btn small disabled={asset.type === 'video' && downloadQueued} onClick={() => asset.type === 'video' ? queueDownload() : preview(asset)}>{asset.type === 'video' ? downloadQueued ? '等待下载' : '重新下载' : '查看文件'}</Btn></td></tr>)}</tbody></table></Panel> : <div className="two-col library-layout">
      <div className="asset-grid">{visible.map(asset => <button key={asset.id} className={`asset-card ${selected?.id === asset.id ? 'selected' : ''}`} onClick={() => setSelectedId(asset.id)}><div className="thumbnail"><img src={asset.preview} alt={asset.name} style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div><div className="asset-card-body"><div className="row between"><strong>{asset.name}</strong><Tag tone={asset.tone}>{asset.status}</Tag></div><small className="muted">{asset.target}</small><small className="subtle">{asset.size}</small></div></button>)}{!visible.length && <div className="empty"><p>没有找到这项素材</p></div>}</div>
      {selected && <Panel title="素材详情" className="asset-inspector"><div className="thumbnail"><img src={selected.preview} alt={selected.name} style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div><h3>{selected.name}</h3><Tag tone={selected.tone}>{selected.status}</Tag><dl className="detail-list"><dt>用途</dt><dd>{selected.target}</dd><dt>文件</dt><dd>{selected.size}</dd><dt>检查</dt><dd>{selected.check}</dd></dl><p className="muted">{selected.history}</p><Btn primary onClick={() => preview(selected)}><Icon name="eye" />{selected.category === 'candidates' ? '预览并确认' : '查看素材'}</Btn>{selected.category === 'adopted' && <button className="text-button muted" onClick={() => openModal({ type: 'history', title: `${selected.name} · 历史版本`, target: selected.modalTarget, material: selected.material, shot: selected.shot, frameKind: selected.frameKind })}>历史版本</button>}</Panel>}
    </div>}
    <p className="subtle">这里只展示逐镜素材。当前作品尚无完整成片。</p>
  </div>;
}

const accountData = [
  { name: '创作账号 01', status: '可使用', tone: 'green', detail: '正在处理首帧任务', initials: '01' },
  { name: '创作账号 02', status: '待核对', tone: 'amber', detail: '镜头 02 的提交结果待核对', initials: '02' },
  { name: '创作账号 03', status: '需要登录', tone: 'amber', detail: '请在浏览器中完成登录', initials: '03' },
];

export function Accounts({ notify, openModal, openChat }) {
  const [selected, setSelected] = useState(accountData[2]);
  const [browserVisible, setBrowserVisible] = useState(true);
  const [pinned, setPinned] = useState(false);
  return <div className="stack">
    <PageTitle title="账号与浏览器" subtitle="管理豆包账号，查看关联会话并处理登录。" action={<Btn onClick={() => openModal({ type: 'task', title: '添加账号', kind: '为新账号命名后，在独立浏览器中完成登录' })}><Icon name="plus" />添加账号</Btn>} />
    <div className="browser-shell"><aside className="account-sidebar"><div className="row between"><strong>我的账号</strong><small className="muted">3 个</small></div>{accountData.map(account => <button key={account.name} className={`list-row account-item ${selected.name === account.name ? 'selected' : ''}`} onClick={() => { setSelected(account); setBrowserVisible(true); }}><span className="account-avatar">{account.initials}</span><span className="stack"><strong>{account.name}</strong><small className="muted">{account.detail}</small><Tag tone={account.tone}>{account.status}</Tag></span></button>)}<p className="subtle">各账号保留各自的登录与会话。</p></aside>
      <section className="browser-preview"><div className="browser-toolbar"><div className="row"><strong>{selected.name}</strong><Tag tone={selected.tone}>{selected.status}</Tag></div><div className="actions"><Btn small onClick={() => { setPinned(!pinned); notify(pinned ? '已取消置顶' : '已置顶账号'); }}>{pinned ? '已置顶' : '置顶'}</Btn><Btn small title="刷新浏览器" aria-label="刷新浏览器" onClick={() => notify('浏览器已刷新')}><Icon name="refresh" /></Btn><Btn small title={browserVisible ? '收起浏览器' : '展开浏览器'} aria-label={browserVisible ? '收起浏览器' : '展开浏览器'} onClick={() => setBrowserVisible(!browserVisible)}><Icon name={browserVisible ? 'minus' : 'expand'} /></Btn><Btn small title="账号更多操作" aria-label="账号更多操作" onClick={() => openModal({ type: 'task', title: selected.name, kind: '重命名、会话详情与移除账号' })}><Icon name="more" /></Btn></div></div>
        {browserVisible ? <div className="browser-design-state"><div className="browser-design-label"><Icon name="eye" />账号浏览器</div><div className="empty"><div className="browser-state-icon"><Icon name={selected.status === '需要登录' ? 'team' : 'chat'} /></div><h2>{selected.status === '需要登录' ? '完成登录后继续创作' : selected.status === '待核对' ? '查看这次提交的结果' : '关联豆包会话已就绪'}</h2><p className="muted">{selected.status === '需要登录' ? '请在当前账号的浏览器中完成登录，登录后继续待办任务。' : '可打开当前作品的关联对话，查看回复或继续调整。'}</p>{selected.status === '需要登录' ? <Btn primary onClick={() => openModal({ type: 'task', title: '登录账号', kind: '请在账号浏览器中完成登录，登录后自动更新状态' })}>查看登录说明</Btn> : <Btn primary onClick={() => openChat(selected.status === '待核对' ? '镜头 02 的视频生成结果' : '雨后的小插曲的关联会话')}><Icon name="chat" />查看关联对话</Btn>}<small className="subtle">自由交流时，工作室会等待你采用回复后再继续。</small></div></div> : <div className="empty"><Icon name="expand" /><p>浏览器面板已收起</p><Btn onClick={() => setBrowserVisible(true)}>展开浏览器</Btn></div>}
        <div className="browser-footer"><Icon name="chat" /><span>当前普通 Chat 请求由工作室自动发送。自由交流期间暂停后续请求。</span></div>
      </section></div>
  </div>;
}

export function Settings({ notify, openModal }) {
  const [preferences, setPreferences] = useState({ finished: true, sound: false, compact: false });
  const [checked, setChecked] = useState(false);
  function toggle(key) { setPreferences(previous => ({ ...previous, [key]: !previous[key] })); }
  const options = [
    ['finished', '任务完成通知', '任务完成或需要处理时，在工作室中提醒。'],
    ['sound', '声音提醒', '需要你处理的任务播放一声提示音。'],
    ['compact', '紧凑显示任务', '减少任务列表的行间距。'],
  ];
  return <div className="stack">
    <PageTitle title="设置与诊断" subtitle="调整工作室偏好，管理备份并检查运行情况。" />
    <div className="two-col"><div className="stack"><Panel title="使用偏好">{options.map(([key, label, description]) => <div className="list-row between" key={key}><div><strong>{label}</strong><p className="muted">{description}</p></div><button role="switch" aria-checked={preferences[key]} aria-label={label} className={`toggle ${preferences[key] ? 'on' : ''}`} onClick={() => toggle(key)}><span /></button></div>)}</Panel>
      <Panel title="创作与保存"><div className="list-row between"><div><strong>作品与素材位置</strong><p className="muted">查看作品文件、候选素材和下载目录。</p></div><Btn small onClick={() => openModal({ type: 'task', title: '文件位置', kind: '作品目录与下载目录预览' })}>查看位置</Btn></div><div className="list-row between"><div><strong>普通 Chat 发送方式</strong><p className="muted">由工作室自动发送；进入自由对话后暂停任务。</p></div><Tag tone="neutral">当前方式</Tag></div><div className="notice"><Icon name="image" /><span>图片生成和上传后，均需预览并确认采用。</span></div></Panel></div>
      <div className="stack"><Panel title="运行检查" action={<Tag tone={checked ? 'green' : 'neutral'}>{checked ? '检查完成' : '尚未检查'}</Tag>}><p className="muted">检查账号连接、文件保存与下载状态。</p>{checked && <div className="stack"><div className="row"><Icon name="check" /><span>文件保存与读取正常</span></div><div className="row"><Icon name="warning" /><span>创作账号 03 需要登录</span></div></div>}<Btn primary onClick={() => { setChecked(true); notify('检查完成 · 1 个账号需要处理'); }}><Icon name="refresh" />{checked ? '重新检查' : '开始检查'}</Btn></Panel>
      <Panel title="更多设置"><details className="settings-details"><summary>备份与恢复</summary><p className="muted">保存作品记录，恢复前可先检查备份内容。</p><div className="actions"><Btn small onClick={() => openModal({ type: 'task', title: '创建备份', kind: '备份范围、保存位置与确认' })}>创建备份</Btn><Btn small onClick={() => openModal({ type: 'task', title: '恢复备份', kind: '选择备份并预览将恢复的内容' })}>恢复备份</Btn></div></details><details className="settings-details"><summary>日志与问题反馈</summary><p className="muted">查看最近的错误，导出用于排查问题的记录。</p><div className="actions"><Btn small onClick={() => openModal({ type: 'task', title: '最近日志', kind: '任务与下载错误记录' })}>查看日志</Btn><Btn small onClick={() => notify('已准备诊断记录')}>导出记录</Btn></div></details><details className="settings-details"><summary>页面适配与诊断详情</summary><p className="muted">页面操作异常时，可查看当前适配情况与检查详情。</p><Btn small onClick={() => openModal({ type: 'task', title: '适配与诊断', kind: '豆包页面适配状态、规则与详细检查' })}>查看详情</Btn></details><details className="settings-details"><summary>关于短剧工作室</summary><p className="muted">逐镜创作工作流</p><p className="subtle">Dola 尚未完成真实端到端验收。</p></details></Panel></div></div>
  </div>;
}
