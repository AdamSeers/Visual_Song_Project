export default function About() {
    return (
        <>
            <header className="masthead">
                <h1><span className="word w1">About</span></h1>
                <p className="lede">
                    The visual song project is a project started by{' '}
                    <a href="https://www.linkedin.com/in/adam-seers-69122336a">Adam Seers</a>{' '}
                    to try to discover if there is a cognitive link between light and sound harmony.
                    The goal of the website is to have a fun tool to play around with to facilitate
                    the potential discovery of such a link.
                </p>
            </header>

            <section className="panel">
                <h2 className="panel-title">the color mapping</h2>
                <p>
                    A pitch like A4 vibrates at 440 Hz, far below anything our eyes can see. We double
                    that frequency until it reaches the same frequency as light (roughly 400&ndash;790
                    THz). Because each octave doubles the frequency, every A &mdash; A2, A3, A4, A5
                    &mdash; comes out the same color: a particular orange-red.
                </p>
                <p>
                    Loudness becomes brightness. Spectral purity becomes saturation &mdash; a sine wave
                    is vibrant, a voice with overtones is softer. Timbre shapes the silhouette: mellow
                    tones round off into circles, brighter tones sharpen into squares. The grid is
                    fixed at eight slots, with vibrant new notes able to displace duller existing ones.
                    Of course this part is only based on what I feel and if you don&rsquo;t agree with
                    this, feel free to give other propositions.
                </p>
            </section>

            <section className="panel">
                <h2 className="panel-title">Some interesting documentation</h2>
                <p>Historical attempts at linking sound to light :</p>
                <a href="https://chromatone.center/theory/interplay/visual-music/">Chromatone - Visual Music & the Poetics of Synaesthesia</a>
                <br /><br />
                <p>Biological predisposition to linking sound to light :</p>
                <a href="https://chromatone.center/theory/interplay/synesthesia/">Chromatone - Synesthesia</a>
                <br /><br />
                <p>Scientifically linking sound to light :</p>
                <a href="https://chromatone.center/theory/interplay/spectrum/">Chromatone - Chromatic spectrum</a>
            </section>
        </>
    )
}