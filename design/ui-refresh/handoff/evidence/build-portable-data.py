"""从只读真实项目快照构建 Make 可移植设计内容；不调用业务服务。"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import subprocess
from pathlib import Path
from typing import Any


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def whitelist(value: dict[str, Any], keys: list[str]) -> dict[str, Any]:
    return {key: copy.deepcopy(value[key]) for key in keys if key in value}


def prompt_content(value: dict[str, Any], prompt_id: str) -> dict[str, Any]:
    # 不导出 job/task/account/平台会话信息；原始、候选和正式正文逐字保留。
    return {"id": prompt_id, **whitelist(value, ["original", "optimized", "final"])}


def probe(path: Path) -> dict[str, Any]:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,width,height,duration:format=duration,size", "-of", "json", str(path)],
        check=True, capture_output=True, text=True,
    )
    return json.loads(result.stdout)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source_dir", type=Path)
    args = parser.parse_args()
    source = args.source_dir
    root = Path(__file__).resolve().parents[1]
    raw_bytes = (source / "project.json").read_bytes()
    project = json.loads(raw_bytes)
    plan = project["plan"]
    representative_shot_id = "sh03"
    assets_by_id = {asset["id"]: asset for asset in project["assets"]}

    upload_files = {
        "fd12bc0a-542e-41b2-87a2-8a2a09dc60f4": "07_CHARACTER.png",
        "8c4cd80a-7ec8-465b-8676-60b2ea3afe4a": "08_KEYFRAME.png",
        "487e566e-152a-4045-a69d-1affdaecf01c": "10_SAMPLE_VIDEO.mp4",
    }
    shot_fields = [
        "id", "order", "characterIds", "scene", "propIds", "propStates", "sceneId", "sceneView",
        "dialogue", "expression", "gaze", "interaction", "camera", "sourceRefs", "narrativePurpose",
        "framing", "blocking", "performance", "sound", "timing", "continuity", "action",
        "startState", "endState", "durationSeconds", "transition", "requestedMode",
    ]
    content_shots = []
    for shot in sorted(plan["shots"], key=lambda value: value["order"]):
        output = whitelist(shot, shot_fields)
        output["summary"] = shot.get("narrativePurpose", "")
        output["prompts"] = {
            kind: prompt_content(value, f"{shot['id']}:{kind}")
            for kind, value in shot.get("prompts", {}).items()
        }
        content_shots.append(output)

    material_content = [
        {
            **whitelist(material, ["id", "kind", "entityId", "name"]),
            "historicalPrompt": prompt_content(material.get("prompt", {}), f"{material['id']}:image"),
            "promptPolicy": "历史基础提示词仅作源数据留档；已采用角色图决定当前形象，不得用于重定义外观。",
        }
        for material in project["materials"]
    ]

    asset_content = []
    for asset in project["assets"]:
        output = whitelist(asset, ["id", "kind", "materialId", "characterId", "shotId", "generationPrompt", "generationFinal"])
        output["uploadFile"] = upload_files.get(asset["id"])
        output["fileAvailability"] = "upload" if output["uploadFile"] else "local-evidence-only"
        output["mediaFacts"] = whitelist(asset.get("validation", {}), ["width", "height", "durationSeconds", "bytes", "sha256", "decoded"])
        asset_content.append(output)

    character_fields = ["id", "name", "role", "purpose", "description", "designOrigin", "continuity", "aliases", "referenceAssetId"]
    content = {
        "project": {
            "id": project["id"],
            "displayLabel": "测试项目（既有真实项目）",
            "sourceRevision": project["revision"],
            "sourceUpdatedAt": project.get("updatedAt"),
            "shotCount": len(plan["shots"]),
            "characterCount": len(plan["characters"]),
            "propCount": len(plan["props"]),
            "sceneCount": len(plan["scenes"]),
            "assetCount": len(project["assets"]),
            "representativeShotId": representative_shot_id,
            "historicalContentWarning": "该既有项目保留历史噜噜/噜妹名称和采用图；不是新项目默认角色、物种或美术规则。新项目从剧本提取角色。",
        },
        "story": {
            "originalScript": project.get("mobileStory", {}).get("text", ""),
            **whitelist(plan, ["sourceSummary", "adaptedStory", "understanding", "sceneDesign"]),
            "contentBasis": copy.deepcopy(project.get("contentBasis", {})),
        },
        "characters": [whitelist(value, character_fields) for value in plan["characters"]],
        "props": copy.deepcopy(plan["props"]),
        "scenes": copy.deepcopy(plan["scenes"]),
        "materials": material_content,
        "shots": content_shots,
        "assets": asset_content,
        "mediaAttachments": {
            "character": {"file": "07_CHARACTER.png", "assetId": "fd12bc0a-542e-41b2-87a2-8a2a09dc60f4", "materialId": "character:ch01", "conversion": "真实已采用JPEG仅解码为PNG，无裁剪、补绘或视觉修改"},
            "keyframe": {"file": "08_KEYFRAME.png", "assetId": "8c4cd80a-7ec8-465b-8676-60b2ea3afe4a", "shotId": representative_shot_id, "conversion": "真实已采用首帧原PNG逐字节复制"},
            "poster": {"file": "09_VIDEO_POSTER.png", "videoAssetId": "487e566e-152a-4045-a69d-1affdaecf01c", "shotId": representative_shot_id, "timeSeconds": 1.0, "conversion": "从真实已选镜头视频1.0秒解码单帧，无其他处理"},
            "video": {"file": "10_SAMPLE_VIDEO.mp4", "assetId": "487e566e-152a-4045-a69d-1affdaecf01c", "shotId": representative_shot_id, "conversion": "真实已选镜头视频由HEVC转为浏览器兼容H.264，画幅、时长与原音频保留，无剪辑、生成或拼接"},
        },
    }

    material_states = []
    for material in project["materials"]:
        related = [asset for asset in project["assets"] if asset.get("materialId") == material["id"]]
        material_states.append({
            "materialId": material["id"],
            "selectedAssetId": material.get("selectedAssetId"),
            "approvedAssetId": material.get("approved", {}).get("assetId"),
            "candidateAssetIds": [asset["id"] for asset in related if asset.get("imageReview", {}).get("state") == "candidate"],
        })
    shot_states = []
    for shot in content_shots:
        related = [asset for asset in project["assets"] if asset.get("shotId") == shot["id"]]
        shot_states.append({
            "shotId": shot["id"],
            "adoptedImages": copy.deepcopy(project.get("adoptedImages", {}).get(shot["id"], {})),
            "selectedVideoAssetId": project.get("selectedVideos", {}).get(shot["id"]),
            "videoAssetIds": [asset["id"] for asset in related if asset["kind"] == "video"],
            "candidateImageAssetIds": [asset["id"] for asset in related if asset.get("imageReview", {}).get("state") == "candidate"],
            "persistedFinalPromptKinds": [kind for kind, prompt in shot["prompts"].items() if prompt.get("final")],
        })
    ui_state = {
        "evidenceType": "由真实持久化项目快照派生；不是实时执行状态，也不是设计模拟",
        "shotNavigation": [{"shotId": shot["id"], "order": shot["order"], "label": f"镜头 {shot['order']:02d}", "summary": shot["summary"]} for shot in content_shots],
        "representativeShotId": representative_shot_id,
        "materialStates": material_states,
        "shotStates": shot_states,
        "assetReviewStates": [{"assetId": asset["id"], **whitelist(asset.get("imageReview", {}), ["state", "target", "resolvedCandidateIds"])} for asset in project["assets"] if asset.get("imageReview")],
        "stateLimits": [
            "保留真实采用、候选和视频选择事实；旧候选resolvedCandidateIds保持源状态，不能仅凭candidate字段宣称仍需处理。",
            "源文件未提供本轮实时生成中/失败的可靠证据；相关原型状态只在独立preview中标为设计模拟。",
            "素材或提示词存在、final字段非空、历史任务完成，都不等于当前依赖已重新校验。",
            "本文件不是可运行的产品项目，不能导回正式工程；仅用于Figma Make设计内容。",
        ],
    }
    output = {
        "schemaVersion": "doubao-design-handoff/1",
        "purpose": "短剧工作室 · 创作工作台 · Figma Make可移植真实样板内容",
        "boundary": {
            "sourceKind": "existing-real-project",
            "productionCodeModified": False,
            "newGenerationStarted": False,
            "contentPolicy": "完整正文在content中保留，摘要另列；uiState仅记录数据事实。设计模拟仅在独立preview中。",
            "redactions": ["accountId与账号信息", "任务/运行/请求控制字段", "平台会话与内部URL", "绝对路径", "签名下载URL", "历史任务日志"],
            "unattachedMediaPolicy": "全部38个普通媒体文件在本地evidence/sample-project中；upload仅附代表人物、首帧、视频帧和短样片。Make不得为其他镜头伪造已完成媒体。",
        },
        "content": content,
        "uiState": ui_state,
        "observedDataGaps": [
            {"kind": "project-count-difference", "detail": "最初打开的ui-project副本是5镜8媒体；本完整内容样板取自另一个既有真实测试项目，6镜38媒体。不是同一版本，不得混写。"},
            {"kind": "missing-media", "shotId": "sh06", "detail": "有完整首帧/尾帧/视频提示词，无媒体文件、采用图或已选视频。"},
            {"kind": "partial-media", "shotId": "sh05", "detail": "有已采用首帧及历史候选，未见已采用尾帧或视频。"},
            {"kind": "unselected-video", "shotId": "sh01", "detail": "有历史视频文件，但selectedVideos无sh01选择。"},
            {"kind": "duration-difference", "shotId": representative_shot_id, "requestedSeconds": 7, "actualVideoStreamSeconds": 5.041667, "actualContainerSeconds": 5.056009, "detail": "保留源文件真实差异；不称该镜头已满足全部当前制作要求。"},
            {"kind": "historical-character-reference", "detail": "3张角色图均为历史已采用图。它们决定既有项目当前形象；历史description/基础提示词不得重新覆盖图片。"},
        ],
    }
    serialized = json.dumps(output, ensure_ascii=False, indent=2) + "\n"
    forbidden = [r"https?://", r"file://", r"/Users/", r"/private/", r"[A-Za-z]:\\", r'"(?:accountId|taskId|runId|requestId|jobId|sourceUrl|relativePath)"']
    if any(re.search(pattern, serialized) for pattern in forbidden):
        raise ValueError("portable content contains a forbidden URL/path/control field")
    (root / "upload" / "03_SAMPLE_CONTENT.json").write_text(serialized)

    provenance = {
        "schemaVersion": 1,
        "capturedLocalDate": "2026-11-02",
        "source": {
            "label": "用户现有桌面测试项目",
            "sourceFile": "existing-desktop-project/project.json",
            "sha256": hashlib.sha256(raw_bytes).hexdigest(),
            "revision": project["revision"],
            "projectId": project["id"],
            "counts": {"shots": len(plan["shots"]), "characters": len(plan["characters"]), "props": len(plan["props"]), "scenes": len(plan["scenes"]), "assets": len(project["assets"])},
        },
        "localProjectCopy": {
            "file": "evidence/sample-project/project.json",
            "boundary": "仅为通过正式界面观察建立的本地隔离副本，初始JSON逐字复制。保留App读取需要的历史ID/accountId与服务记录。不是Make上传资料；不得整体上传或对外分享。",
            "initialCopySha256": hashlib.sha256(raw_bytes).hexdigest(),
            "originalUnmodifiedAtExtraction": sha256(source / "project.json") == hashlib.sha256(raw_bytes).hexdigest(),
            "canChangeWhenOpenedInApp": True,
        },
        "assetSourceFiles": [{"assetId": asset["id"], "sourceRelativeFile": asset["relativePath"], "sha256": sha256(source / asset["relativePath"]), "bytes": (source / asset["relativePath"]).stat().st_size, "realSource": True} for asset in project["assets"]],
        "uploadOutputs": [
            {"file": f"upload/{filename}", "sourceAssetId": asset_id, "sha256": sha256(root / "upload" / filename), "facts": probe(root / "upload" / filename)}
            for asset_id, filename in upload_files.items()
        ] + [{"file": "upload/09_VIDEO_POSTER.png", "sourceAssetId": "487e566e-152a-4045-a69d-1affdaecf01c", "sourceTimeSeconds": 1.0, "sha256": sha256(root / "upload" / "09_VIDEO_POSTER.png"), "facts": probe(root / "upload" / "09_VIDEO_POSTER.png")}],
        "conversions": content["mediaAttachments"],
        "portableContent": {"file": "upload/03_SAMPLE_CONTENT.json", "sha256": sha256(root / "upload" / "03_SAMPLE_CONTENT.json"), "whitelistExtraction": True, "forbiddenUrlPathControlFieldScanPassed": True, "fullPromptVariantsPreserved": True},
        "realVersusSimulated": "本清单所列内容和媒体均取自真实项目；生成中/失败等模拟另见preview，不能当作实机证据。",
        "gaps": output["observedDataGaps"],
    }
    (root / "evidence" / "data-provenance.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"shots": len(content_shots), "materials": len(material_content), "assets": len(asset_content), "portableBytes": len(serialized.encode()), "sourceUnchanged": provenance["localProjectCopy"]["originalUnmodifiedAtExtraction"]}))


if __name__ == "__main__":
    main()
