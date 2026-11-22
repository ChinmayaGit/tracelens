package dev.tracelens

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.BugReport
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

class MainActivity : ComponentActivity() {
    private val vm: MainViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handleShare(intent)
        setContent { TraceLensTheme { Screen(vm) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleShare(intent)
    }

    /** Text shared from another app (crash dialog, logcat viewer, chat) lands in the input. */
    private fun handleShare(intent: Intent?) {
        if (intent?.action == Intent.ACTION_SEND && intent.type == "text/plain") {
            intent.getStringExtra(Intent.EXTRA_TEXT)?.let(vm::setInput)
        }
    }
}

/* ------------------------------------------------------------------ */
/* Theme                                                                */
/* ------------------------------------------------------------------ */

private val Brand = Color(0xFF6D4DFF)
private val DeviceGreen = Color(0xFF16A34A)
private val CloudBlue = Color(0xFF2563EB)
private val RulesPurple = Color(0xFF7C3AED)
private val Warn = Color(0xFFD97706)
private val Bad = Color(0xFFDC2626)
private val Mono = FontFamily.Monospace

@Composable
fun TraceLensTheme(content: @Composable () -> Unit) {
    val scheme = if (isSystemInDarkTheme()) {
        darkColorScheme(primary = Color(0xFF8B6DFF), background = Color(0xFF0E1016), surface = Color(0xFF161922))
    } else {
        lightColorScheme(primary = Brand, background = Color(0xFFF6F7FB), surface = Color.White)
    }
    MaterialTheme(colorScheme = scheme, content = content)
}

private fun sourceColor(s: StepSource) = when (s) {
    StepSource.ON_DEVICE -> DeviceGreen
    StepSource.LOCAL_NETWORK -> Color(0xFF0E7490)
    StepSource.IN_CLOUD -> CloudBlue
    StepSource.LOCAL_RULES -> RulesPurple
    StepSource.SKIPPED -> Color.Gray
}

private fun sevColor(s: String) = when (s) {
    "low" -> DeviceGreen
    "medium" -> Warn
    else -> Bad
}

/* ------------------------------------------------------------------ */
/* Screen                                                               */
/* ------------------------------------------------------------------ */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun Screen(vm: MainViewModel) {
    val ui by vm.ui.collectAsState()
    val run = ui.run
    if (ui.showSettings) SettingsSheet(ui, vm)
    if (ui.showCrashes) CrashesSheet(ui, vm)
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("TraceLens", fontWeight = FontWeight.Bold)
                        Text("secrets stay on your device", style = MaterialTheme.typography.labelSmall, color = Color.Gray)
                    }
                },
                actions = {
                    if (ui.useNetwork) {
                        Badge(if (ui.lanStatus?.online == true) "LAN online" else "LAN offline",
                            if (ui.lanStatus?.online == true) Color(0xFF0E7490) else Bad, Modifier.padding(end = 4.dp))
                    } else DevicePill(ui.device)
                    IconButton(onClick = { vm.showSettings(true) }) { Icon(Icons.Default.Settings, contentDescription = "Settings") }
                },
            )
        },
    ) { pad ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(pad),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { ModeCard(ui, vm) }
            item { StatsRow(ui.history) }
            item { InputCard(ui, vm) }
            if (!ui.online) item { Banner("Offline: on-device steps still work; cloud steps resume when you reconnect.", Warn) }
            run.error?.let { item { ErrorBanner(it, ui.refreshing, vm::refresh) } }
            if (run.steps.isNotEmpty() || run.pending != null) item { PipelineCard(run) }
            if (run.review) item { ReviewCard(run, vm) }
            run.triage?.let { t -> item { TriageCard(t, canEscalate = run.analysis.isEmpty() && run.pending == null && ui.mode != ProcessingMode.PRIVATE, vm) } }
            if (run.analysis.isNotEmpty()) item { Section("Root-cause analysis") { MarkdownText(run.analysis) } }
            if (run.sanitized.isNotEmpty() && !run.review) item { SanitizedCard(run, ui.mode == ProcessingMode.PRIVATE) }
            item { Text("History", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 8.dp)) }
            if (ui.history.isEmpty()) item { Text("No traces yet. Try a sample.", color = Color.Gray) }
            items(ui.history, key = { it.id }) { HistoryRow(it, vm) }
            item {
                Text(
                    "Firebase AI Logic hybrid inference · cloud model ${ui.config.cloudModel}",
                    style = MaterialTheme.typography.labelSmall, color = Color.Gray,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp),
                )
            }
        }
    }
}

@Composable
private fun DevicePill(d: DeviceStatus) {
    val (label, color) = when (d) {
        DeviceStatus.AVAILABLE -> "Gemini Nano ready" to DeviceGreen
        DeviceStatus.DOWNLOADABLE -> "Nano not downloaded" to Color.Gray
        DeviceStatus.DOWNLOADING -> "Nano downloading…" to Warn
        DeviceStatus.UNAVAILABLE -> "No on-device AI" to Color.Gray
    }
    Badge(label, color, Modifier.padding(end = 12.dp))
}

@Composable
private fun Badge(text: String, color: Color, modifier: Modifier = Modifier) {
    Text(
        text,
        color = color,
        fontSize = 11.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = modifier.clip(RoundedCornerShape(50)).background(color.copy(alpha = 0.14f)).padding(horizontal = 10.dp, vertical = 4.dp),
    )
}

@Composable
private fun Section(title: String? = null, accent: Color? = null, content: @Composable () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = accent?.let { androidx.compose.foundation.BorderStroke(1.5.dp, it) },
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            title?.let { Text(it, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold) }
            content()
        }
    }
}

@Composable
private fun Banner(text: String, color: Color) {
    Text(
        text,
        color = color,
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(color.copy(alpha = 0.12f)).padding(12.dp),
    )
}

@Composable
private fun ErrorBanner(text: String, refreshing: Boolean, onRetry: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Bad.copy(alpha = 0.12f))
            .padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, color = Bad, modifier = Modifier.weight(1f).padding(vertical = 8.dp))
        if (refreshing) {
            CircularProgressIndicator(Modifier.padding(12.dp).size(20.dp), strokeWidth = 2.dp, color = Bad)
        } else {
            TextButton(onClick = onRetry) {
                Icon(Icons.Default.Refresh, contentDescription = null, tint = Bad, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(4.dp))
                Text("Retry", color = Bad)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ModeCard(ui: UiState, vm: MainViewModel) {
    val desc = mapOf(
        ProcessingMode.HYBRID to "Gemini Nano when available, cloud for fallback and deep dives",
        ProcessingMode.PRIVATE to "On-device only. Nothing is sent to the cloud",
        ProcessingMode.CLOUD to "For devices without Gemini Nano. Secrets still removed locally by rules",
    )
    Section("Processing mode") {
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            ProcessingMode.entries.forEachIndexed { i, m ->
                SegmentedButton(
                    selected = ui.mode == m,
                    onClick = { vm.setMode(m) },
                    enabled = m != ProcessingMode.PRIVATE || ui.device == DeviceStatus.AVAILABLE,
                    shape = SegmentedButtonDefaults.itemShape(i, ProcessingMode.entries.size),
                ) { Text(m.name.lowercase().replaceFirstChar { it.uppercase() }) }
            }
        }
        Text(desc[ui.mode]!!, style = MaterialTheme.typography.bodySmall, color = Color.Gray)

        when {
            ui.download != null -> {
                val p = ui.download
                Text(if (p >= 0f) "Downloading Gemini Nano… ${(p * 100).toInt()}%" else "Downloading Gemini Nano…")
                if (p >= 0f) LinearProgressIndicator(progress = { p }, Modifier.fillMaxWidth())
                else LinearProgressIndicator(Modifier.fillMaxWidth())
                TextButton(onClick = vm::cancelDownload) { Text("Cancel") }
            }
            ui.useNetwork -> Banner(
                if (ui.lanStatus?.online == true)
                    "Private steps run on ${ui.lan.model.ifEmpty { "your server" }} at ${ui.lan.url}. Nothing leaves your network" +
                        (if (ui.mode == ProcessingMode.PRIVATE) ", including deep dives." else ".")
                else "Your local network server (${ui.lan.url}) is offline. Start it or switch to Built-in in Settings.",
                if (ui.lanStatus?.online == true) Color(0xFF0E7490) else Bad,
            )
            ui.device == DeviceStatus.UNAVAILABLE && ui.mode != ProcessingMode.CLOUD -> Banner(
                "This phone can't run Gemini Nano (needs AICore, e.g. Pixel 9+ / Galaxy S24+). " +
                    "TraceLens uses the cloud with local rule-based redaction and asks you to review before sending.",
                Warn,
            )
            (ui.device == DeviceStatus.DOWNLOADABLE || ui.device == DeviceStatus.DOWNLOADING) && ui.mode != ProcessingMode.CLOUD -> {
                Text("Get Gemini Nano for private, offline triage. Managed by AICore and shared across apps.",
                    style = MaterialTheme.typography.bodySmall)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = vm::startDownload) { Text("Download model") }
                    OutlinedButton(onClick = { vm.setMode(ProcessingMode.CLOUD) }) { Text("Use Cloud") }
                }
            }
        }
        ui.notice?.let { Text(it, color = DeviceGreen, style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable
private fun StatsRow(history: List<TraceDoc>) {
    var ai = 0
    var local = 0
    var secrets = 0
    for (d in history) {
        secrets += d.redactionTotal
        for (s in d.steps) {
            if (s.source == StepSource.ON_DEVICE || s.source == StepSource.IN_CLOUD) ai++
            if (s.source == StepSource.ON_DEVICE) local++
        }
    }
    val pct = if (ai > 0) local * 100 / ai else 0
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf("${history.size}" to "traces", "$secrets" to "secrets kept local", "$pct%" to "AI steps on-device").forEach { (v, l) ->
            Card(Modifier.weight(1f)) {
                Column(Modifier.padding(10.dp)) {
                    Text(v, fontWeight = FontWeight.Bold, fontSize = 20.sp)
                    Text(l, fontSize = 11.sp, color = Color.Gray, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

@Composable
private fun InputCard(ui: UiState, vm: MainViewModel) {
    val clipboard = LocalClipboardManager.current
    Section("Paste an error, stack trace or log") {
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SAMPLES.forEach { (label, text) -> AssistChip(onClick = { vm.setInput(text) }, label = { Text(label) }) }
        }
        OutlinedTextField(
            value = ui.input,
            onValueChange = vm::setInput,
            modifier = Modifier.fillMaxWidth().heightIn(min = 140.dp, max = 260.dp),
            textStyle = TextStyle(fontFamily = Mono, fontSize = 12.sp),
            placeholder = { Text("Paste text, or share a crash log to TraceLens from any app…") },
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = vm::loadCrashes) {
                Icon(Icons.Default.BugReport, contentDescription = "Import crashes from installed apps")
            }
            IconButton(onClick = { clipboard.getText()?.text?.let(vm::setInput) }) {
                Icon(Icons.Default.ContentPaste, contentDescription = "Paste")
            }
            if (ui.input.isNotEmpty()) IconButton(onClick = { vm.setInput("") }) {
                Icon(Icons.Default.Close, contentDescription = "Clear")
            }
            Spacer(Modifier.weight(1f))
            Text("${ui.cloudLeft}/$USER_DAILY_LIMIT cloud left", fontSize = 11.sp, color = Color.Gray,
                modifier = Modifier.padding(end = 8.dp))
            Button(onClick = vm::analyze, enabled = ui.uid != null && ui.run.pending == null && ui.input.isNotBlank()) {
                Text(if (ui.run.pending != null) "Working…" else "Analyze privately")
            }
        }
    }
}

@Composable
private fun PipelineCard(run: RunState) {
    Section("Pipeline") {
        run.steps.forEach { s ->
            Column {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(s.step, fontWeight = FontWeight.Medium, fontSize = 13.sp, modifier = Modifier.weight(1f))
                    Badge(s.source.label, sourceColor(s.source))
                    if (s.source != StepSource.SKIPPED) Text("${s.ms} ms", fontSize = 12.sp, color = Color.Gray)
                }
                s.note?.let { Text(it, fontSize = 11.sp, color = Color.Gray) }
            }
        }
        run.pending?.let {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                Text(it, fontSize = 13.sp, color = Color.Gray)
            }
        }
    }
}

/** Highlight placeholders like [AWS_KEY_1]. */
private fun highlighted(text: String) = buildAnnotatedString {
    var last = 0
    for (m in Regex("\\[[A-Z_]+_\\d+]").findAll(text)) {
        append(text.substring(last, m.range.first))
        withStyle(SpanStyle(background = Color(0x55FFD54F), fontWeight = FontWeight.SemiBold)) { append(m.value) }
        last = m.range.last + 1
    }
    append(text.substring(last))
}

@Composable
private fun ReviewCard(run: RunState, vm: MainViewModel) {
    var tfv by remember(run.sanitized) { mutableStateOf(TextFieldValue(highlighted(run.sanitized))) }
    val sel = tfv.selection
    val selected = if (sel.collapsed) "" else tfv.text.substring(sel.min, sel.max).trim()
    Section("Review before sending to the cloud", accent = Warn) {
        Banner(
            "Gemini Nano isn't running here, so only the rules removed secrets. Long-press and select any name, ID or " +
                "hostname below to hide it, then send.",
            Warn,
        )
        BasicTextField(
            value = tfv,
            onValueChange = { tfv = it.copy(annotatedString = highlighted(it.text)) },
            readOnly = true,
            textStyle = TextStyle(fontFamily = Mono, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurface),
            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
                .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.05f)).padding(10.dp),
        )
        FlowRowButtons(
            hideLabel = if (selected.isNotEmpty()) "Hide “${selected.take(20)}${if (selected.length > 20) "…" else ""}”" else null,
            onHide = { vm.hide(selected); tfv = tfv.copy(selection = TextRange.Zero) },
            onSend = vm::approveAndSend,
            onCancel = vm::cancelReview,
        )
        if (run.redactions.isNotEmpty()) RedactionList(run.redactions)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FlowRowButtons(hideLabel: String?, onHide: () -> Unit, onSend: () -> Unit, onCancel: () -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(onClick = onHide, enabled = hideLabel != null) { Text(hideLabel ?: "Select text to hide") }
        Button(onClick = onSend) { Text("Looks clean, send →") }
        TextButton(onClick = onCancel) { Text("Cancel") }
    }
}

@Composable
private fun TriageCard(t: Triage, canEscalate: Boolean, vm: MainViewModel) {
    Section(accent = sevColor(t.severity)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(t.errorType, fontWeight = FontWeight.Bold)
                Text(t.language, fontSize = 12.sp, color = Color.Gray)
            }
            Badge(t.severity.uppercase(), sevColor(t.severity))
        }
        Text(t.summary)
        Text("Likely cause", fontSize = 12.sp, color = Color.Gray)
        Text(t.likelyCause, fontSize = 14.sp)
        Text("Quick fix", fontSize = 12.sp, color = Color.Gray)
        Text(t.quickFix, fontSize = 14.sp)
        val pct = (t.confidence * 100).toInt()
        LinearProgressIndicator(
            progress = { t.confidence.toFloat() },
            color = if (pct >= 75) DeviceGreen else if (pct >= 50) Warn else Bad,
            modifier = Modifier.fillMaxWidth().height(6.dp),
        )
        Text("$pct% confident", fontSize = 12.sp)
        if (canEscalate) Button(onClick = vm::deepDive) { Text("Deep dive in cloud →") }
    }
}

@Composable
private fun SanitizedCard(run: RunState, isPrivate: Boolean) {
    Section(if (isPrivate) "Sanitized trace (stays private)" else "What the cloud sees") {
        SelectionContainer {
            Text(
                highlighted(run.sanitized),
                fontFamily = Mono,
                fontSize = 11.sp,
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
                    .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.05f)).padding(10.dp),
            )
        }
        if (run.redactions.isNotEmpty()) {
            Text("Kept on this device", fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
            RedactionList(run.redactions)
        }
    }
}

@Composable
private fun RedactionList(items: List<Redaction>) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        items.forEach { r ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(r.placeholder, fontFamily = Mono, fontSize = 11.sp,
                    modifier = Modifier.background(Color(0x55FFD54F)).padding(horizontal = 3.dp))
                Text(
                    if (r.original.length > 6) r.original.take(3) + "•••" + r.original.takeLast(2) else "•••",
                    fontFamily = Mono, fontSize = 11.sp, color = Color.Gray, modifier = Modifier.weight(1f),
                )
                val (l, c) = when (r.by) {
                    "rule" -> "rule" to RulesPurple
                    "user" -> "you" to Warn
                    else -> "Gemini Nano" to DeviceGreen
                }
                Badge(l, c)
            }
        }
    }
}

@Composable
private fun HistoryRow(d: TraceDoc, vm: MainViewModel) {
    Card(Modifier.fillMaxWidth().clickable { vm.open(d) }) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(8.dp).clip(CircleShape).background(sevColor(d.triage?.severity ?: "low")))
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(d.title, maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 14.sp)
                Text(
                    "${d.redactionTotal} redacted · ${d.platform}",
                    fontSize = 11.sp, color = Color.Gray,
                )
            }
            IconButton(onClick = { vm.delete(d) }) { Icon(Icons.Default.Close, contentDescription = "Delete") }
        }
    }
}

/** Minimal Markdown: ## headings, fenced code, bullets, **bold**. */
@Composable
private fun MarkdownText(md: String) {
    var inCode = false
    val code = StringBuilder()
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        for (line in md.lines()) {
            if (line.trimStart().startsWith("```")) {
                if (inCode) {
                    Text(
                        code.toString().trimEnd(), fontFamily = Mono, fontSize = 11.sp,
                        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
                            .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f)).padding(8.dp),
                    )
                    code.clear()
                }
                inCode = !inCode
                continue
            }
            if (inCode) {
                code.append(line).append('\n')
                continue
            }
            when {
                line.startsWith("#") -> Text(line.trimStart('#', ' '), fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 8.dp))
                line.isBlank() -> Spacer(Modifier.height(2.dp))
                else -> Text(bold(line.replace(Regex("^\\s*[-*] "), "• ")), fontSize = 14.sp)
            }
        }
        if (inCode && code.isNotEmpty()) Text(code.toString(), fontFamily = Mono, fontSize = 11.sp)
    }
}

private fun bold(s: String) = buildAnnotatedString {
    val parts = s.split("**")
    parts.forEachIndexed { i, p ->
        if (i % 2 == 1) withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(p.replace("`", "")) }
        else append(p.replace("`", ""))
    }
}


/* ------------------------------------------------------------------ */
/* Settings: engine (built-in Nano / bigger model on LAN), requirements */
/* ------------------------------------------------------------------ */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsSheet(ui: UiState, vm: MainViewModel) {
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = { vm.showSettings(false) }) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 32.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("Settings & setup", style = MaterialTheme.typography.titleLarge)
            Text("Local AI engine", fontWeight = FontWeight.SemiBold)
            Text("Used for private steps (redaction, triage). The cloud is only used in Hybrid/Cloud mode.",
                fontSize = 12.sp, color = Color.Gray)

            RadioRow(!ui.useNetwork, "Built-in: Gemini Nano (default)",
                "Runs on this phone via AICore. Needs a supported device (Pixel 9+, Galaxy S24+…), ~3 GB free storage.") {
                vm.setUseNetwork(false)
            }
            if (!ui.useNetwork) {
                NanoOption.entries.forEach { o ->
                    Row(Modifier.padding(start = 28.dp)) {
                        RadioRow(ui.nano == o, o.label, o.detail) { vm.setNano(o) }
                    }
                }
            }
            RadioRow(ui.useNetwork, "Bigger model on my network",
                "A powerful computer on your Wi-Fi runs the model (Ollama). Nothing leaves your network.") {
                vm.setUseNetwork(true)
            }
            if (ui.useNetwork) LanSettings(ui, vm)
        }
    }
}


@Composable
private fun RadioRow(selected: Boolean, title: String, detail: String, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 4.dp), verticalAlignment = Alignment.Top) {
        androidx.compose.material3.RadioButton(selected = selected, onClick = onClick)
        Column(Modifier.padding(top = 10.dp)) {
            Text(title, fontWeight = FontWeight.Medium)
            Text(detail, fontSize = 12.sp, color = Color.Gray)
        }
    }
}

@Composable
private fun LanSettings(ui: UiState, vm: MainViewModel) {
    val st = ui.lanStatus
    Column(Modifier.padding(start = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Server", fontWeight = FontWeight.SemiBold)
            Badge(if (st == null) "Unknown" else if (st.online) "Online" else "Offline",
                if (st?.online == true) DeviceGreen else Bad)
        }
        OutlinedTextField(
            value = ui.lan.url, onValueChange = { vm.setLan(ui.lan.copy(url = it)) },
            label = { Text("Server address") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("http://192.168.1.20:11434") },
        )
        OutlinedButton(onClick = vm::testLan) { Text("Test connection") }
        if (st != null && !st.online) {
            Banner("The device at ${ui.lan.url} is offline or unreachable (${st.error}). Make sure it's on the same Wi-Fi " +
                "and running:  OLLAMA_HOST=0.0.0.0 ollama serve", Bad)
        }
        if (st?.online == true) {
            Text("Model on this server", fontSize = 13.sp)
            st.models.forEach { m ->
                RadioRow(ui.lan.model == m.name, m.name, "${m.params.ifEmpty { "${m.sizeGb} GB" }} · needs ~${m.minRamGb} GB RAM on the server") {
                    vm.setLan(ui.lan.copy(model = m.name))
                }
            }
            if (st.models.isEmpty()) Text("No models installed. Run: ollama pull qwen2.5-coder:7b", fontSize = 12.sp)
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            androidx.compose.material3.Switch(checked = ui.lan.memorySaver, onCheckedChange = { vm.setLan(ui.lan.copy(memorySaver = it)) })
            Column(Modifier.padding(start = 10.dp)) {
                Text("Memory saver (stream weights from disk)", fontWeight = FontWeight.Medium)
                Text("Memory-maps the model file so only the layers in use sit in RAM, smaller context window, unloads " +
                    "after 1 min idle. Lets a big model run on a smaller machine; first answer is slower.",
                    fontSize = 12.sp, color = Color.Gray)
            }
        }
        Text("Recommended models (min RAM on the server)", fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
        RECOMMENDED_LAN_MODELS.forEach { (name, ram, note) ->
            Text("• $name: $ram GB · $note", fontSize = 12.sp)
        }
    }
}

/* ------------------------------------------------------------------ */
/* Debug installed apps: recent crashes from the system crash buffer    */
/* ------------------------------------------------------------------ */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CrashesSheet(ui: UiState, vm: MainViewModel) {
    val clipboard = LocalClipboardManager.current
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = vm::hideCrashes) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Recent app crashes", style = MaterialTheme.typography.titleLarge)
            if (!ui.crashesAllApps) {
                Banner("Android only lets TraceLens read other apps' crashes after a one-time grant from a computer " +
                    "(USB debugging on). Until then you only see TraceLens's own crashes.", Warn)
                Text(Crashes.GRANT_COMMAND, fontFamily = Mono, fontSize = 11.sp,
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
                        .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f)).padding(8.dp))
                OutlinedButton(onClick = { clipboard.setText(androidx.compose.ui.text.AnnotatedString(Crashes.GRANT_COMMAND)) }) {
                    Text("Copy command")
                }
            }
            when {
                ui.crashes == null -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp); Text("Reading crash log…")
                }
                ui.crashes.isEmpty() -> Text("No recent crashes found.", color = Color.Gray)
                else -> ui.crashes.forEach { c ->
                    Card(Modifier.fillMaxWidth().clickable { vm.pickCrash(c) }) {
                        Column(Modifier.padding(12.dp)) {
                            Text(c.app, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(c.exception, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            Text(c.time, fontSize = 11.sp, color = Color.Gray)
                        }
                    }
                }
            }
            Text("Tap a crash to load it. It's redacted before any AI sees it.", fontSize = 12.sp, color = Color.Gray)
        }
    }
}
