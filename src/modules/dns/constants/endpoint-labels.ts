/**
 * The label an endpoint stamps on every Kubernetes object it creates for
 * itself.
 *
 * It is the endpoint's register of what is its own, and it exists because
 * "managed by flui" is not the same question: the application's Service is
 * managed by flui as well, and a teardown that read the wider label deleted the
 * application's Service when one of its gateway routes was removed. Written at
 * creation, read at deletion, and nowhere else — an object without it was made
 * by somebody else and is somebody else's to remove.
 */
export const ENDPOINT_ID_LABEL = 'flui-endpoint-id';
