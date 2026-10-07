/** Platform-neutral assembly of generated Host Remote contributions. */
import productAnalyticsRemote from '@deepseek-ai/dsh-client-product-analytics/remote';
import agentPresetsRemote from '@deepseek-ai/dsh-agent-preset-registry/remote';
import userQuestionsRemote from '@deepseek-ai/dsh-user-questions/remote';
import commandsRemote from '@deepseek-ai/dsh-commands/remote';
import accountRemote from '@deepseek-ai/dsh-api-account-controller/remote';
import settingsControllerRemote from '@deepseek-ai/dsh-api-settings-controller/remote';
import officeToPdfRemote from '@deepseek-ai/dsh-office-to-pdf/remote';
import goalsRemote from '@deepseek-ai/dsh-goal/remote';
import scheduleRemote from '@deepseek-ai/dsh-schedule/remote';
import llmRemote from '@deepseek-ai/dsh-llm/remote';
import dynamicRemote from '@deepseek-ai/dsh-cordis-host-runner/remote';
import pluginManagerRemote from '@deepseek-ai/dsh-plugin-manager/remote';
import pluginRegistryProbeRemote from '@deepseek-ai/dsh-client-ui-plugin-manager/remote';
import pluginInventoryRemote from '@deepseek-ai/dsh-host-plugin-inventory/remote';
import messageFeedbackRemote from '@deepseek-ai/dsh-message-feedback/remote';
import permissionPresetsRemote from '@deepseek-ai/dsh-permission-presets/remote';
import sessionFeedbackRemote from '@deepseek-ai/dsh-command-feedback/remote';
import fileUploadsRemote from '@deepseek-ai/dsh-client-file-upload/remote';
import sessionReferencesRemote from '@deepseek-ai/dsh-session-reference/remote';
import subagentsRemote from '@deepseek-ai/dsh-subagent/remote';
import sessionRemote from '@deepseek-ai/dsh-api-session-controller/remote';
import jobRemote from '@deepseek-ai/dsh-api-job-controller/remote';
import workspaceRemote from '@deepseek-ai/dsh-api-workspace-controller/remote';
import terminalRemote from '@deepseek-ai/dsh-api-terminal-controller/remote';
import workspaceFilesRemote from '@deepseek-ai/dsh-api-workspace-files/remote';
/** Required service: the typed Client Remote contribution mount. */
export const inject = ['remote'];
/**
 * Mount the Host capabilities explicitly selected for this Client assembly.
 * @param ctx - Client Cordis root carrying the typed API service.
 * @returns disposer after every selected Remote namespace is ready.
 */
export async function apply(ctx) {
    const disposers = [];
    try {
        for (const contribution of [
            productAnalyticsRemote, agentPresetsRemote, commandsRemote, settingsControllerRemote, accountRemote,
            goalsRemote, llmRemote, dynamicRemote, scheduleRemote,
            pluginInventoryRemote, pluginManagerRemote, pluginRegistryProbeRemote, messageFeedbackRemote, sessionFeedbackRemote,
            fileUploadsRemote, sessionReferencesRemote,
            permissionPresetsRemote, subagentsRemote, sessionRemote, jobRemote, workspaceRemote, workspaceFilesRemote, terminalRemote,
            officeToPdfRemote, userQuestionsRemote,
        ]) {
            disposers.push(await ctx.remote.$mount(contribution));
        }
    }
    catch (error) {
        for (const dispose of disposers.reverse())
            await dispose();
        throw error;
    }
    // Unwound in reverse mount order, so a namespace never outlives one mounted
    // after it.
    return async () => {
        for (const dispose of disposers.reverse())
            await dispose();
    };
}
//# sourceMappingURL=index.js.map