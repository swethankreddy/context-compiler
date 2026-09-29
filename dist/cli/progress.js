const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Progress lines on stderr: an animated spinner on a TTY, plain "✓" lines otherwise, nothing when quiet. */
export function createProgress(out, quiet) {
    if (quiet)
        return { start() { }, done() { } };
    if (!out.isTTY)
        return { start() { }, done: (_s, label) => void out.write(`✓ ${label}\n`) };
    let timer;
    const stop = () => {
        if (timer)
            clearInterval(timer);
        timer = undefined;
        out.write("\r\x1b[K");
    };
    return {
        start(_step, label) {
            stop();
            let i = 0;
            out.write(`${FRAMES[0]} ${label}`);
            timer = setInterval(() => out.write(`\r${FRAMES[++i % FRAMES.length]} ${label}`), 80);
            timer.unref();
        },
        done(_step, label) {
            stop();
            out.write(`✓ ${label}\n`);
        },
    };
}
