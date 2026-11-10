import { configureVideoOptions, getVideoModelUiLabel, clickAITab, getCurrentCreationConversation, readPetStoryComposer, preparePageSubmission,
  submitPromptOnce, uploadPetStoryImages, uploadReferenceImages, uploadReferenceAudio, resolveVideoArtifact, startNewConversation } from '../utils/doubaoBridge';
import type { WebviewHandle, SubmissionDispatchSafety, SubmissionDispatchResult, BackgroundPageSubmission } from '../utils/doubaoBridge';
import type { PetStoryComposerSnapshot } from '../utils/petstoryControls';
import type { SendButtonTarget } from '../utils/submissionControls';
import type { VideoArtifactResolution } from '../utils/videoArtifactResolver';
import { observeVideoArtifact } from '../utils/videoArtifactObservation';
import type { VideoArtifactObservationOptions } from '../utils/videoArtifactObservation';
import { beginVideoPageOperation, bindVideoOperationDocument, captureVideoPageOperation } from './videoExecutionContext';
import type { VideoPageOperation } from './videoExecutionContext';
import { VideoControlReadinessError } from '../utils/videoControlReadiness';

export interface VideoComposerSnapshot { composer: PetStoryComposerSnapshot; submit: SendButtonTarget; nativeInputAvailable: boolean }

/** 正式视频适配器：自检、准备和恢复均消费本模块的只读输入区和原消息读法。 */
export class DoubaoVideoAdapter {
  private operationPage?: WebviewHandle;
  constructor(readonly page: WebviewHandle) {}
  async begin(operation: VideoPageOperation): Promise<() => void> {
    const release = await beginVideoPageOperation(this.page, operation);
    this.operationPage = captureVideoPageOperation(this.page);
    return release;
  }
  /** 已结束实例仍保留原操作边界；不能在同页的新运行开始后重新认领权限。 */
  private currentPage(): WebviewHandle { return captureVideoPageOperation(this.operationPage || this.page); }
  bindDocument(): Promise<void> { return bindVideoOperationDocument(this.currentPage()); }
  async readComposer(): Promise<VideoComposerSnapshot> {
    return this.readPageComposer(this.currentPage());
  }
  private async readPageComposer(page: WebviewHandle): Promise<VideoComposerSnapshot> {
    const composer = await readPetStoryComposer(page);
    const submit = await preparePageSubmission(page);
    return { composer, submit, nativeInputAvailable: typeof page.sendInputEvent === 'function' };
  }
  prepareSession(...args: Parameters<typeof startNewConversation> extends [WebviewHandle, ...infer Rest] ? Rest : never): ReturnType<typeof startNewConversation> {
    return startNewConversation(this.currentPage(), ...args);
  }
  selectMode(onDiagnostic?: Parameters<typeof clickAITab>[2]): Promise<boolean> { return clickAITab(this.currentPage(), 'video', onDiagnostic); }
  async configure(config: Parameters<typeof configureVideoOptions>[1], options?: Parameters<typeof configureVideoOptions>[2]): Promise<void> {
    const page = this.currentPage();
    const startedAt = Date.now();
    await configureVideoOptions(page, config, options);
    // 参数操作、最终核对和自检共用正式输入区快照，不能凭另一套浮层探针单独宣布就绪。
    const { composer } = await this.readPageComposer(page);
    if (!composer.present || composer.selectedSkill !== 'video' || composer.model !== getVideoModelUiLabel(config.model)
      || composer.aspectRatio !== config.aspectRatio || composer.duration !== Number.parseInt(config.duration, 10)) {
      const error = new VideoControlReadinessError('final_readback', { ready: false, failureStage: 'final_readback',
        attempts: 1, elapsedMs: Date.now() - startedAt, failureReason: 'value_not_applied', missingControl: 'prompt_editor' });
      await options?.onReadiness?.(error.diagnostic);
      throw error;
    }
  }
  uploadReferences(...args: Parameters<typeof uploadPetStoryImages> extends [WebviewHandle, ...infer Rest] ? Rest : never): ReturnType<typeof uploadPetStoryImages> { return uploadPetStoryImages(this.currentPage(), ...args); }
  uploadImages(...args: Parameters<typeof uploadReferenceImages> extends [WebviewHandle, ...infer Rest] ? Rest : never): ReturnType<typeof uploadReferenceImages> { return uploadReferenceImages(this.currentPage(), ...args); }
  uploadAudio(file: Parameters<typeof uploadReferenceAudio>[1]): ReturnType<typeof uploadReferenceAudio> { return uploadReferenceAudio(this.currentPage(), file); }
  dispatch(safety: SubmissionDispatchSafety, background?: BackgroundPageSubmission): Promise<SubmissionDispatchResult> { return submitPromptOnce(this.currentPage(), { ...safety, activation: 'native_media' }, background); }
  readOriginalMessage(options?: Parameters<typeof getCurrentCreationConversation>[1]): ReturnType<typeof getCurrentCreationConversation> { return getCurrentCreationConversation(this.currentPage(), options); }
  resolve(context: Parameters<typeof resolveVideoArtifact>[1]): Promise<VideoArtifactResolution> { return resolveVideoArtifact(this.currentPage(), context); }
  observe(options: Omit<VideoArtifactObservationOptions, 'resolve'> & { context: Parameters<typeof resolveVideoArtifact>[1]; initialResolution?: VideoArtifactResolution }): Promise<VideoArtifactResolution> {
    // 受理后准备权限已释放；观察只读取原消息，执行权由 observer 的原 run 校验负责。
    // 这里没有上传／配置／发送能力，不能让已结束的准备令牌阻断正常生成等待。
    let initial = options.initialResolution;
    return observeVideoArtifact({ ...options, resolve: (timeoutMs: number, signal: AbortSignal): Promise<VideoArtifactResolution> => {
      if (initial?.status === 'resolved') { const selected = initial; initial = undefined; return Promise.resolve(selected); }
      return resolveVideoArtifact(this.page, { ...options.context, timeoutMs, signal });
    } });
  }
}
