interface Props {
  isAdmin: boolean;
  onBack: () => void;
}

export function GuidePage({ isAdmin, onBack }: Props) {
  return <section className="guide-view">
    <header className="dashboard-heading"><div><button className="mobile-back visible-back" onClick={onBack}>← Till startsidan</button><p className="eyebrow">Kom igång</p><h1>Användarguide</h1><p>Så här funkar Kompis Split, från skapad grupp till uppgjort saldo.</p></div></header>

    <section className="panel guide-panel">
      <div className="panel-title"><div><p className="eyebrow">Två sätt att dela</p><h2>Grupper eller Snabbnota — vilket ska jag använda?</h2></div></div>
      <p>Använd en <strong>Grupp</strong> för allt som pågår över flera dagar med samma gäng — en resa, en fest med flera inköp, eller vad som helst där ni lägger till utgifter allt eftersom och gör upp i slutet.</p>
      <p>Använd en <strong>Snabbnota</strong> för ett enskilt kvitto som ska delas här och nu — middagen ikväll, fikat, eller vad ni just betalat. Skanna kvittot, dela länken, och alla bockar av vad de själva tog.</p>
    </section>

    <section className="panel guide-panel">
      <div className="panel-title"><div><p className="eyebrow">Steg för steg</p><h2>Grupper</h2></div></div>
      <ul className="guide-steps">
        <li><strong>Skapa en grupp</strong> via "＋ Ny grupp" i sidomenyn. Ge den ett namn, valfria start-/slutdatum.</li>
        <li><strong>Bjud in gänget</strong> med "Bjud in" — dela QR-koden eller länken. Länken gäller i 14 dagar.</li>
        <li><strong>Lägg till utgifter</strong> med "＋ Lägg till utgift". Välj vem som betalade och hur den ska delas: jämnt, procent, exakta belopp, eller viktat (t.ex. om någon åt dubbelt så mycket).</li>
        <li><strong>Bifoga kvitton</strong> direkt på en utgift — upp till 5 bilder eller PDF:er per utgift.</li>
        <li><strong>Gör upp</strong> under fliken "Gör upp" — appen räknar ut de färre betalningarna som faktiskt behövs för att alla ska ligga jämnt. Öppna Swish direkt om mottagaren har ett Swish-nummer sparat, annars kopieras betalningsinfon.</li>
        <li><strong>Arkivera</strong> en avslutad grupp (skrivskyddar den, allt sparas) eller <strong>ta bort</strong> den från listorna när ni är helt klara — utgifter och betalningar finns kvar i historiken, men uppladdade kvitton raderas permanent.</li>
      </ul>
    </section>

    <section className="panel guide-panel">
      <div className="panel-title"><div><p className="eyebrow">Steg för steg</p><h2>Snabbnota</h2></div></div>
      <ul className="guide-steps">
        <li><strong>Skanna kvittot</strong> via "＋ Skanna nota". Ta ett foto eller välj en bild — lokal AI läser av rader och totalsumma automatiskt (tar några sekunder).</li>
        <li><strong>Kontrollera raderna</strong> innan ni skapar notan. AI:n är bra men inte perfekt — dubbelkolla särskilt namn, antal och ovanliga rader.</li>
        <li><strong>Dela länken</strong> — den skapas automatiskt när notan skapas. "Bjud in" skapar fler giltiga länkar vid behov utan att de gamla slutar fungera.</li>
        <li><strong>Alla bockar av sitt eget</strong> — ingen inloggning krävs för gäster, bara namn och (valfritt) Swish-nummer.</li>
        <li><strong>Betala</strong> — den som inte är ägare ser en Swish-knapp för sin del av notan.</li>
        <li><strong>Markera betald</strong> — eftersom Swish inte går att verifiera automatiskt (appen har ingen koppling till Swish alls) markerar ägaren själv varje person som betald när Swishen väl kommit in. Alla i notan ser vem som har betalat och inte.</li>
        <li><strong>Avsluta</strong> notan när allt är avbockat och betalt — låser den mot fler ändringar.</li>
      </ul>
    </section>

    <section className="panel guide-panel">
      <div className="panel-title"><div><p className="eyebrow">Tips</p><h2>Kvitton och foto-avläsning</h2></div></div>
      <p>Fota kvittot rakt uppifrån mot en mörk eller enfärgad bakgrund om möjligt — det gör det lättare för AI:n att hitta kanterna. Se till att hela kvittot, inklusive totalsumman längst ner, syns i bilden.</p>
      <p>Om en rad blir fel går det alltid att redigera namn, antal och belopp för hand innan ni skapar notan eller lägger till utgiften.</p>
    </section>

    <section className="panel guide-panel">
      <div className="panel-title"><div><p className="eyebrow">Överblick</p><h2>Statistik</h2></div></div>
      <p>Fliken "Statistik" visar en översikt över alla dina aktiva och arkiverade grupper: kategorier, platser, vem som lagt ut mest, och en trend över de senaste 12 månaderna.</p>
    </section>

    <section className="panel guide-panel">
      <div className="panel-title"><div><p className="eyebrow">Hittat något som inte funkar?</p><h2>Rapportera en bugg</h2></div></div>
      <p>Klicka "⚠ Rapportera en bugg" i sidomenyn (eller varningsikonen i mobilhuvudet). Beskriv vad som hände och bifoga gärna en skärmbild — appen bifogar automatiskt vilken sida du var på och vad du gjort precis innan, så det blir mycket lättare att hitta och rätta felet.</p>
    </section>

    {isAdmin && <section className="panel guide-panel">
      <div className="panel-title"><div><p className="eyebrow">Endast administratörer</p><h2>Adminfunktioner</h2></div></div>
      <ul className="guide-steps">
        <li><strong>Administration</strong>-sidan visar alla användare, grupper och snabbnotor i hela appen, oavsett om du själv är medlem.</li>
        <li><strong>Demoläge</strong> låter dig utforska hela appen med fiktiv exempeldata, helt isolerat från riktiga konton och grupper — perfekt för att visa upp appen utan risk.</li>
        <li><strong>Buggrapporter</strong> som skickas in visas här, med teknisk information och eventuell skärmbild. Markera dem som lösta eller ta bort dem när de är åtgärdade.</li>
        <li>Du kan göra andra användare till admin, inaktivera konton, och arkivera eller ta bort vilken grupp som helst.</li>
      </ul>
    </section>}
  </section>;
}
