import "./index.css";
import {Composition} from "remotion";
import {BeeefOutro, beeefOutroSchema} from "./BeeefOutro";
import {BeeefSaasPromo, beeefSaasPromoSchema} from "./BeeefSaasPromo";
import {BeeefLogoOutro} from "./BeeefLogoOutro";
import {HelloWorld, myCompSchema} from "./HelloWorld";
import {Logo, myCompSchema2} from "./HelloWorld/Logo";

export const RemotionRoot: React.FC = () => {
	return (
		<>
			<Composition
				component={BeeefSaasPromo}
				defaultProps={{
					accentBlue: "#245cff",
					accentOrange: "#ff6a14",
					actionLine: "Tu choisis le gagnant.",
					aiLine: "Une IA analyse le debat.",
					beeSrc: "beeef-bee-clean.png",
					brandLine: "live debate arenas",
					conceptLine: "2 personnes. 1 debat.",
					ctaLine: "Rejoins le debat.",
					darkBackground: "#040507",
					introLine: "Et si debattre devenait interactif ?",
					lightBackground: "#f3f7fc",
					liveLine: "Le public observe en temps reel.",
					resultLine: "Le plus convaincant gagne.",
					tagline:
						"Des debats live, des predictions en points et un verdict IA dans une interface premium.",
					textSrc: "beeef-text-clean.png",
				}}
				durationInFrames={2100}
				fps={60}
				height={1920}
				id="BeeefSaasPromoVertical"
				schema={beeefSaasPromoSchema}
				width={1080}
			/>

			<Composition
				component={BeeefOutro}
				defaultProps={{
					accentColor: "#ff6a14",
					backgroundColor: "#020202",
					beeSrc: "beeef-bee-clean.png",
					beeWidth: 230,
					shouldFadeOut: true,
					textSrc: "beeef-text-clean.png",
					textWidth: 680,
				}}
				durationInFrames={204}
				fps={60}
				height={1920}
				id="BeeefOutroTikTok"
				schema={beeefOutroSchema}
				width={1080}
			/>

			<Composition
				component={BeeefLogoOutro}
				durationInFrames={120}
				fps={30}
				height={1080}
				id="BeeefLogoOutro"
				width={1920}
			/>

			<Composition
				component={HelloWorld}
				defaultProps={{
					logoColor1: "#91EAE4",
					logoColor2: "#86A8E7",
					titleColor: "#000000",
					titleText: "Welcome to Remotion",
				}}
				durationInFrames={150}
				fps={30}
				height={1080}
				id="HelloWorld"
				schema={myCompSchema}
				width={1920}
			/>

			<Composition
				component={Logo}
				defaultProps={{
					logoColor1: "#91dAE2" as const,
					logoColor2: "#86A8E7" as const,
				}}
				durationInFrames={150}
				fps={30}
				height={1080}
				id="OnlyLogo"
				schema={myCompSchema2}
				width={1920}
			/>
		</>
	);
};
