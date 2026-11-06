/** Conversation activation is distinct from storing a task via MCP.
 * An adapter may be introduced only after a documented, permitted way to
 * resume the *existing* ChatGPT conversation has been verified end-to-end.
 */
export type ActivationState = 'unsupported' | 'accepted' | 'uncertain' | 'rejected';

export interface ConversationActivationAdapter {
    readonly name: string;
    readonly resumesExistingConversation: boolean;
    activate(targetConversationRef: string, taskId: string): Promise<{ state: ActivationState; receipt?: string }>;
    reconcile(receipt: string): Promise<{ state: ActivationState }>;
}

/** No URL automation, private endpoints, session-cookie reuse, or desktop input. */
export const noActivationAdapter: ConversationActivationAdapter = {
    name: 'none',
    resumesExistingConversation: false,
    async activate() { return { state: 'unsupported' }; },
    async reconcile() { return { state: 'unsupported' }; }
};
