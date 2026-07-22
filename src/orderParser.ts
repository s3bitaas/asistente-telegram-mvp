// src/orderParser.ts

/**
 * Tipos para el menú y la orden parseada.
 */

export interface MenuItem {
  nombre: string;
  tipo: "base" | "extra";
  precio: number;
  sinonimos: string[];
}

export interface ParsedOrderItem {
  producto: string;
  cantidad: number;
  extras: string[];
  precio_unitario: number;
  precio_total: number;
}

export interface ParsedOrder {
  items: ParsedOrderItem[];
  confianza: "alta" | "media" | "baja";
  requiere_confirmacion: boolean;
  total_pedido: number;
}

/**
 * Construye el prompt de sistema con el menú y las instrucciones.
 */
function buildSystemPrompt(menu: MenuItem[]): string {
  // Formateamos el menú para que el modelo entienda nombres, sinónimos y precios
  const menuText = menu
    .map(
      (item) =>
        `- ${item.nombre} (${item.tipo}): $${item.precio} | sinónimos: [${item.sinonimos.join(", ")}]`
    )
    .join("\n");

  return `Eres un asistente que interpreta pedidos de comida en español mexicano coloquial.
Tu tarea es extraer los productos, cantidades y extras mencionados en el texto del usuario,
basándote exclusivamente en el siguiente menú:

${menuText}

REGLAS ESTRICTAS:
1. Para cada ítem, identifica el producto exacto del menú (puede estar mencionado por su nombre o por cualquiera de sus sinónimos).
2. Los "extras" solo pueden ser productos del menú con tipo "extra". Si se menciona un extra que no está en el menú, omítelo.
3. Calcula el precio_unitario como la suma del precio del producto base más todos los extras que lo acompañen.
4. precio_total = cantidad * precio_unitario.
5. total_pedido = suma de todos los precio_total.
6. "confianza" debe ser:
   - "alta": si todos los productos y extras se encuentran claramente en el menú, sin ambigüedad.
   - "media": si hay alguna duda menor pero aún así se puede inferir razonablemente.
   - "baja": si hay ambigüedad grave o algún producto no se encuentra en el menú.
7. "requiere_confirmacion" debe ser true SI confianza es "baja" O si la orden parece incompleta/ambigua; de lo contrario, false.
8. NUNCA adivines ni inventes productos que no estén en el menú. Si no estás seguro, baja la confianza y activa requiere_confirmacion.
9. Si el texto menciona varios productos iguales, agrúpalos en un solo ítem con cantidad > 1.
10. Devuelve EXCLUSIVAMENTE un objeto JSON válido, sin markdown, sin texto adicional. No uses bloques de código (\`\`\`). Solo el JSON crudo.

Ejemplo de formato de respuesta esperada (usa SIEMPRE los productos reales del menú de arriba, este es solo el formato):
{"items":[{"producto":"NombreDelProductoReal","cantidad":1,"extras":[],"precio_unitario":0,"precio_total":0}],"confianza":"alta","requiere_confirmacion":false,"total_pedido":0}`;
}

/**
 * Construye un prompt de reintento más estricto, recordando la salida esperada.
 */
function buildRetryPrompt(): string {
  return "La respuesta anterior no era un JSON válido. Vuelve a intentarlo, pero esta vez asegúrate de que la salida sea ESTRICTAMENTE un objeto JSON válido sin ningún otro texto. Respeta exactamente la estructura indicada.";
}

/**
 * Llama a la API de DeepSeek para obtener la interpretación del pedido.
 * Si el JSON falla, reintenta una vez.
 */
async function callDeepSeek(
  systemPrompt: string,
  userMessage: string,
  apiKey: string,
  retry = true
): Promise<ParsedOrder> {
  const url = "https://api.deepseek.com/v1/chat/completions";

  const messages: { role: string; content: string }[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  let responseText: string;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages,
        temperature: 0,
        max_tokens: 300,
      }),
    });

    if (!res.ok) {
      throw new Error(`API DeepSeek respondió con ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    responseText = data.choices[0].message.content.trim();
  } catch (err) {
    throw new Error(`Error al llamar a DeepSeek: ${err instanceof Error ? err.message : err}`);
  }

  // Intentamos parsear la respuesta
  try {
    return JSON.parse(responseText) as ParsedOrder;
  } catch {
    if (retry) {
      // Reintentamos con un mensaje más estricto
      const retryMessages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
        { role: "assistant", content: responseText }, // Incluimos la respuesta fallida para contexto
        { role: "user", content: buildRetryPrompt() },
      ];

      const res2 = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "deepseek-v4-flash",
          messages: retryMessages,
          temperature: 0,
          max_tokens: 300,
        }),
      });

      if (!res2.ok) {
        throw new Error(`Reintento fallido: ${res2.status}`);
      }

      const data2 = await res2.json();
      const secondResponse = data2.choices[0].message.content.trim();

      return JSON.parse(secondResponse) as ParsedOrder;
    } else {
      throw new Error("No se pudo parsear el JSON devuelto por DeepSeek después de reintentar.");
    }
  }
}

/**
 * Interpreta un texto libre de pedido y devuelve un objeto ParsedOrder estructurado.
 * @param textoPedido - El texto en español mexicano coloquial (ej. "quiero 2 tortas de mila con queso")
 * @param menu - El arreglo de objetos MenuItem que representan el menú del negocio.
 * @returns Una promesa que resuelve a un ParsedOrder.
 */
export async function parseOrder(
  textoPedido: string,
  menu: MenuItem[]
): Promise<ParsedOrder> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("Falta la variable de entorno DEEPSEEK_API_KEY");
  }

  const systemPrompt = buildSystemPrompt(menu);
  return callDeepSeek(systemPrompt, textoPedido, apiKey, true);
}

/**
 * Convierte un ParsedOrder en un mensaje de confirmación para el usuario de Telegram.
 * @param order - El objeto con la orden ya interpretada.
 * @returns Texto formateado listo para enviar al chat.
 */
export function formatOrderMessage(order: ParsedOrder): string {
  const lines: string[] = ["📝 Orden anotada:"];

  for (const item of order.items) {
    const extrasStr = item.extras.length > 0 ? ` (${item.extras.join(", ")})` : "";
    lines.push(`- ${item.cantidad} ${item.producto}${extrasStr} ($${item.precio_unitario.toFixed(2)} c/u)`);
  }

  lines.push(`Total a la caja: $${order.total_pedido.toFixed(2)}`);

  // Si requiere confirmación, añadimos advertencia
  if (order.requiere_confirmacion) {
    lines.push("⚠️ Revisa bien tu pedido, la interpretación es de baja confianza.");
  }

  return lines.join("\n");
}