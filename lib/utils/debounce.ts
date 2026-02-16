/**
 * Debounce and throttle utilities for function execution control
 */

/**
 * Creates a debounced version of a function that delays execution until after
 * the specified delay has elapsed since the last call.
 *
 * @param fn - The function to debounce
 * @param delay - The delay in milliseconds
 * @returns A debounced version of the function
 *
 * @example
 * const debouncedSearch = debounce((query: string) => {
 *   console.log('Searching for:', query);
 * }, 300);
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
    fn: T,
    delay: number
): (...args: Parameters<T>) => void {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    return function debounced(...args: Parameters<T>) {
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
        }
        timeoutId = setTimeout(() => {
            fn(...args);
        }, delay);
    };
}

/**
 * Creates a throttled version of a function that only executes at most once
 * per specified interval.
 *
 * @param fn - The function to throttle
 * @param interval - The minimum interval in milliseconds between executions
 * @returns A throttled version of the function
 *
 * @example
 * const throttledScroll = throttle((event: Event) => {
 *   console.log('Scroll event:', event);
 * }, 100);
 */
export function throttle<T extends (...args: unknown[]) => unknown>(
    fn: T,
    interval: number
): (...args: Parameters<T>) => void {
    let lastCall = 0;

    return function throttled(...args: Parameters<T>) {
        const now = Date.now();
        if (now - lastCall >= interval) {
            lastCall = now;
            fn(...args);
        }
    };
}
