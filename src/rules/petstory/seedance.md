# Seedance · petstory-r11-v1

改编来源：https://github.com/silentbuilds/seedance-prompt-forge/tree/33fd93e0dbd1d5ccf85e4bb819300101d2e7284b
采用文件：skills/seedance-prompt-forge/SKILL.md、references/reference-materials.md、references/advanced-modes.md、references/checklist.md。
许可：MIT；完整声明见 seedance-prompt-forge.LICENSE。

先逐项声明实际素材与角色的对应，再写主体、主要动作、场景、动作开始状态、中间过程、结束状态及必要运镜。角色身份、服装、持物归属、站位和视线保持明确；不要用模糊代词代替多人映射。
只选择当前镜头需要的角色；素材标签随真实上传顺序，普通中文“第 N 张参考图”即可，不假设网页支持 @Image 等专用语法。视频参数由控件设置，不在提示词中伪造 API 参数。
每镜头承担一个清楚事件，动作要能在计划 5～10 秒内合理完成；避免同时过多动作、矛盾运镜。保留用户指定的事件、语言和身份，不擅自添加台词、音乐、字幕或故事。
原生首尾帧必须有两个已验证槽位，分别描述起止及中间动作；普通参考图中提到开头／结尾不等于原生首尾帧。首帧、首尾帧与参考图须分别表述。
cut 采用本镜头状态约束；continue 必须在实际制作时绑定上一选中视频的真实末帧，不能用计划尾图冒充。结构检查不证明实际运动或跨镜连贯质量。
上游面向 Dreamina 2.5；不把其模型版本、数量、时长、免费权益当成豆包普通网页能力，不执行上游脚本或调用外部模型。
